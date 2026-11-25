// Scalpel: a two-tier pump.fun launch bot for agent-fun/replay/v2.
//
// What the dev window taught (128k events, 1222 coins, 24h): buying every
// launch loses at every entry age and every hold horizon — mean return is
// negative and gets worse the longer you hold. But coins spike hard before
// they die: the mean peak inside 10 slots after entry is +5%, inside 100
// slots +17%, and 22% of coins 2x within 100 slots. Two facts from the
// sweeps shape this bot:
//
//   * The moonshots are decided in the first two slots. A coin that has
//     already run 2-3x on 5+ SOL of net inflow from 3+ distinct buyers in
//     its first slot, bought then and held under a wide trailing stop,
//     wins only ~18% of the time — but its winners are 2-5x runners that
//     pay for the whole book. Enter one slot later and the edge is gone;
//     loosen the 2-3x runup band to 1.5x and the book bleeds; tighten the
//     trailing stop to 30% and the runners get cut before they run.
//   * That runner tier alone only trades ~77 coins a day, which risks
//     falling under the 20-distinct-mint guardrail in a 6-hour window. So
//     a second, small-stake pacer tier buys the next tier of launches
//     (age 1-2 slots, any runup, 3+ SOL net inflow) for 0.02 SOL a coin
//     and banks a quick +5% or cuts out after 30 slots. It is roughly
//     breakeven on its own; its job is the mint count and a steadier
//     hourly equity curve, which is what the Sharpe ranking rewards.
//     It may hold at most 3 coins at once, so a runner signal always
//     finds a free slot.
//
// A pure function of the batches it is fed: no clock, no randomness, no
// I/O, so the two graded executions agree byte for byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // Runner tier: the moonshot tier. Entered only in a coin's first two
  // slots, only while it is already running 2-3x on real crowd flow.
  rMinAge: number;
  rMaxAge: number;
  rMinNetSol: number;
  rMinBuyers: number;
  rMinRunup: number;
  rMaxRunup: number;
  rMaxDevBuySol: number;
  rMinRqSol: number;
  rMaxRqSol: number;
  rStakeSol: number;
  /** Whole position: exit when it is worth this fraction under its all-in cost. */
  rStopLoss: number;
  /** Trailing stop arms once value is this fraction over cost. */
  rTrailArm: number;
  /** Once armed, exit on a fall of this fraction from the best value. */
  rTrail: number;
  /** Exit after holding this many slots. */
  rMaxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  rStaleSlots: number;
  // Pacer tier: the guardrail tier. Small stakes, quick exits, many coins.
  sMinAge: number;
  sMaxAge: number;
  sMinNetSol: number;
  sMinBuyers: number;
  sMinRunup: number;
  sMaxRunup: number;
  sMinRqSol: number;
  sMaxRqSol: number;
  sStakeSol: number;
  /** Most pacer positions open at once (the rest of the slots stay for runners). */
  sMaxConcurrent: number;
  /** Sell when the position is worth this fraction over its all-in cost. */
  sTakeProfit: number;
  /** Exit when the position is worth this fraction under its all-in cost. */
  sStopLoss: number;
  /** Exit after holding this many slots. */
  sMaxHold: number;
  /** Shared. */
  skipDevSold: boolean;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  rMinAge: 0,
  rMaxAge: 1,
  rMinNetSol: 5,
  rMinBuyers: 3,
  rMinRunup: 2.0,
  rMaxRunup: 3.0,
  rMaxDevBuySol: 25,
  rMinRqSol: 0.3,
  rMaxRqSol: 50,
  rStakeSol: 0.15,
  rStopLoss: 0.08,
  rTrailArm: 0.25,
  rTrail: 0.4,
  rMaxHold: 300,
  rStaleSlots: 120,
  sMinAge: 1,
  sMaxAge: 2,
  sMinNetSol: 3,
  sMinBuyers: 3,
  sMinRunup: 1.0,
  sMaxRunup: 3.0,
  sMinRqSol: 0.3,
  sMaxRqSol: 50,
  sStakeSol: 0.02,
  sMaxConcurrent: 3,
  sTakeProfit: 0.05,
  sStopLoss: 0.15,
  sMaxHold: 30,
  skipDevSold: true,
  minBuySol: 0.01,
  buySlipBps: 10_000,
};

const LAMPORTS = 1e9;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface Tape {
  created: number | null;
  creator: Pubkey;
  /** Create price (virtual quote / virtual token). */
  createPrice: number;
  trades: TapeTrade[];
  /** Distinct non-creator buyers seen. */
  buyers: Set<Pubkey>;
  /** Net SOL inflow since create (buys minus sells). */
  net: number;
  devBuy: number;
  devSold: boolean;
  lastTradeSlot: number;
  lastPrice: number;
  /** Real SOL reserve at the latest trade. */
  rqSol: number;
  complete: boolean;
}

type Tier = 'runner' | 'pacer';

interface Held {
  tier: Tier;
  opened: number;
  /** Best value/cost ratio seen (runner tier's trailing stop). */
  peakRatio: number;
  /** Tx fees paid on this position's fills (buy + sells), in SOL. */
  txPaid: number;
  /** True once a buy of this position has filled. */
  filled: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (lamports). */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * 125n + 9999n) / 10_000n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Coins bought once already: never bought again. */
  const decided = new Set<Pubkey>();
  const keep = Math.max(p.rMaxAge, p.sMaxAge, p.rStaleSlots) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: '',
        createPrice: 0,
        trades: [],
        buyers: new Set(),
        net: 0,
        devBuy: 0,
        devSold: false,
        lastTradeSlot: -1,
        lastPrice: 0,
        rqSol: 0,
        complete: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal for one tier on a coin's opening tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, tier: Tier): boolean => {
    if (t.created === null) return false;
    const age = now - t.created;
    const minAge = tier === 'runner' ? p.rMinAge : p.sMinAge;
    const maxAge = tier === 'runner' ? p.rMaxAge : p.sMaxAge;
    if (age < minAge || age > maxAge) return false;
    if (t.complete) return false;
    if (t.net < (tier === 'runner' ? p.rMinNetSol : p.sMinNetSol)) return false;
    if (t.buyers.size < (tier === 'runner' ? p.rMinBuyers : p.sMinBuyers)) return false;
    if (tier === 'runner' && t.devBuy > p.rMaxDevBuySol) return false;
    if (p.skipDevSold && t.devSold) return false;
    if (t.createPrice <= 0 || t.lastPrice <= 0) return false;
    const rq = t.rqSol;
    if (rq < (tier === 'runner' ? p.rMinRqSol : p.sMinRqSol)) return false;
    if (rq > (tier === 'runner' ? p.rMaxRqSol : p.sMaxRqSol)) return false;
    const runup = t.lastPrice / t.createPrice;
    const minRunup = tier === 'runner' ? p.rMinRunup : p.sMinRunup;
    const maxRunup = tier === 'runner' ? p.rMaxRunup : p.sMaxRunup;
    if (runup < minRunup || runup > maxRunup) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const traded = new Set<Pubkey>();

      // Fold this batch's fills into the held book (tx fees paid).
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        }
      }

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.user;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.lastPrice = t.createPrice;
          t.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (e.is_buy) {
            t.net += sol;
            if (e.user === t.creator) t.devBuy += sol;
            else t.buyers.add(e.user);
          } else {
            t.net -= sol;
            if (e.user === t.creator) t.devSold = true;
          }
          t.lastPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.rqSol = Number(e.real_quote_reserves) / LAMPORTS;
          t.lastTradeSlot = e.slot;
          traded.add(e.mint);
        } else {
          tapeOf(e.mint).complete = true;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // Exits first, per tier.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = pos.token_amount;
        const valueSol = Number(sellValueLamports(tokens, vq, vt)) / LAMPORTS - txSol;
        const costSol = Number(pos.cost_lamports) / LAMPORTS + h.txPaid + txSol;
        if (costSol <= 0 || tokens <= 0n) continue;
        const ratio = valueSol / costSol;
        if (ratio > h.peakRatio) h.peakRatio = ratio;
        const t = tapeOf(mint);

        let exit = false;
        if (h.tier === 'runner') {
          if (ratio <= 1 - p.rStopLoss) exit = true;
          if (!exit && h.peakRatio >= 1 + p.rTrailArm && ratio <= h.peakRatio * (1 - p.rTrail)) exit = true;
          if (!exit && now - h.opened > p.rMaxHold) exit = true;
          if (!exit && t.lastTradeSlot >= 0 && now - t.lastTradeSlot > p.rStaleSlots) exit = true;
        } else {
          if (ratio >= 1 + p.sTakeProfit) exit = true;
          if (!exit && ratio <= 1 - p.sStopLoss) exit = true;
          if (!exit && now - h.opened > p.sMaxHold) exit = true;
        }
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
      }

      // Entries: runners first (they take priority for slots), then pacers.
      // Coins that traded in this batch, strongest opening flow first.
      const candidates: { mint: Pubkey; net: number; tier: Tier }[] = [];
      for (const mint of traded) {
        if (decided.has(mint) || held.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (entrySignal(t, now, 'runner')) candidates.push({ mint, net: t.net, tier: 'runner' });
        else if (entrySignal(t, now, 'pacer')) candidates.push({ mint, net: t.net, tier: 'pacer' });
      }
      candidates.sort((a, b) => (a.tier === b.tier ? b.net - a.net : a.tier === 'runner' ? -1 : 1) || (a.mint < b.mint ? -1 : 1));

      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let pacerOpen = 0;
      for (const h of held.values()) if (h.tier === 'pacer') pacerOpen++;
      for (const { mint, tier } of candidates) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (tier === 'pacer' && pacerOpen >= p.sMaxConcurrent) continue;
        const stake = tier === 'runner' ? p.rStakeSol : p.sStakeSol;
        const capLamports = state.maxBuyLamports(mint);
        let amount = stake;
        const capSol = Number(capLamports) / LAMPORTS;
        if (amount > capSol) amount = capSol;
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        decided.add(mint);
        held.set(mint, { tier, opened: now, peakRatio: 0, txPaid: 0, filled: false });
        free -= amount + txSol;
        slotsLeft -= 1;
        if (tier === 'pacer') pacerOpen++;
      }
      return orders;
    },
  };
}
