// Pump.fun Sharpe Sprint — a two-speed momentum bot.
//
// The idea in one paragraph: most fresh pump.fun curves either pop in their
// first couple of slots or never do. This bot watches every new curve for a
// sharp early run-up that is backed by real SOL inflow and several distinct
// buyers, then rides it with one of two position styles. A "runner" takes
// the bigger stake in the fastest movers and guards the ride with a trailing
// stop; a "pacer" takes a small stake in steadier movers and banks a quick
// 5% gain or cuts at -15%. Everything here is a pure function of the
// batches the harness delivers: no clock, no randomness, no I/O, so the two
// grading executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

/** Lamports in one SOL, as a plain number for SOL-denominated maths. */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Curve fee taken on a sell, in basis points: 95 protocol + 30 creator. */
const SELL_FEE_BPS = 125n;

/** A fast mover: bigger stake, trailing stop, long leash, staleness watch. */
export interface RunnerSettings {
  minAge: number;
  maxAge: number;
  minNetSol: number;
  minBuyers: number;
  minRunup: number;
  maxRunup: number;
  maxDevBuySol: number;
  minRqSol: number;
  maxRqSol: number;
  stakeSol: number;
  stopLoss: number;
  trailArm: number;
  trailGiveback: number;
  maxHoldSlots: number;
  staleSlots: number;
}

/** A steady mover: small stake, at most three open at once, quick exit. */
export interface PacerSettings {
  minAge: number;
  maxAge: number;
  minNetSol: number;
  minBuyers: number;
  minRunup: number;
  maxRunup: number;
  minRqSol: number;
  maxRqSol: number;
  stakeSol: number;
  maxConcurrent: number;
  takeProfit: number;
  stopLoss: number;
  maxHoldSlots: number;
}

/** Knobs shared by both tiers. */
export interface SharedSettings {
  skipDevSold: boolean;
  minBuySol: number;
  buySlipBps: number;
}

export interface StrategySettings {
  runner: RunnerSettings;
  pacer: PacerSettings;
  shared: SharedSettings;
}

export const DEFAULT_PARAMS: StrategySettings = {
  runner: {
    minAge: 0,
    maxAge: 1,
    minNetSol: 5,
    minBuyers: 3,
    minRunup: 2.0,
    maxRunup: 3.0,
    maxDevBuySol: 25,
    minRqSol: 0.3,
    maxRqSol: 50,
    stakeSol: 0.15,
    stopLoss: 0.08,
    trailArm: 0.25,
    trailGiveback: 0.4,
    maxHoldSlots: 300,
    staleSlots: 120,
  },
  pacer: {
    minAge: 1,
    maxAge: 2,
    minNetSol: 3,
    minBuyers: 3,
    minRunup: 1.0,
    maxRunup: 3.0,
    minRqSol: 0.3,
    maxRqSol: 50,
    stakeSol: 0.02,
    maxConcurrent: 3,
    takeProfit: 0.05,
    stopLoss: 0.15,
    maxHoldSlots: 30,
  },
  shared: {
    skipDevSold: true,
    minBuySol: 0.01,
    buySlipBps: 10000,
  },
};

/** One trade remembered on a mint's tape. */
interface TapeEntry {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

/** Everything remembered about one mint: its birth and its trade flow. */
interface MintTape {
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  entries: TapeEntry[];
  buyers: Set<string>;
  netSol: number;
  devBuySol: number;
  devSold: boolean;
  lastTradeSlot: number;
  lastPrice: number;
  rqSol: number;
  complete: boolean;
}

function freshTape(): MintTape {
  return {
    createdSlot: null,
    creator: null,
    createPrice: 0,
    entries: [],
    buyers: new Set<string>(),
    netSol: 0,
    devBuySol: 0,
    devSold: false,
    lastTradeSlot: -1,
    lastPrice: 0,
    rqSol: 0,
    complete: false,
  };
}

type TierName = 'runner' | 'pacer';

/** A position this bot opened and is still responsible for. */
interface OpenPosition {
  tier: TierName;
  openedSlot: number;
  peakRatio: number;
  txPaidSol: number;
  filled: boolean;
}

/**
 * What a full sell of `tokens` against virtual reserves (vq, vt) brings
 * back in SOL after the curve fee, before the transaction fee. The fee is
 * rounded up to the next lamport, matching the harness's own rounding.
 */
function sellProceedsSol(tokens: bigint, vq: bigint, vt: bigint): number {
  const gross = (tokens * vq) / (vt + tokens);
  const afterFee = gross - (gross * SELL_FEE_BPS + 9999n) / 10000n;
  return Number(afterFee) / LAMPORTS_PER_SOL;
}

export function createStrategy(settings: StrategySettings): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  const tapes = new Map<string, MintTape>();
  const open = new Map<string, OpenPosition>();
  const decided = new Set<string>();

  // Trades older than this can no longer matter: the oldest entry window
  // plus the staleness horizon, with a few slots of slack.
  const keepSlots =
    Math.max(settings.runner.maxAge, settings.pacer.maxAge, settings.runner.staleSlots) + 5;

  function tapeFor(mint: string): MintTape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = freshTape();
      tapes.set(mint, tape);
    }
    return tape;
  }

  // Which tier, if any, does this tape qualify for right now? Runner first:
  // a mint that clears the runner bar is never downgraded to a pacer.
  function tierFor(tape: MintTape, now: number): TierName | null {
    if (tape.createdSlot === null || tape.complete) return null;
    if (tape.createPrice <= 0 || tape.lastPrice <= 0) return null;
    if (settings.shared.skipDevSold && tape.devSold) return null;
    const age = now - tape.createdSlot;
    const runup = tape.lastPrice / tape.createPrice;
    const r = settings.runner;
    if (
      age >= r.minAge &&
      age <= r.maxAge &&
      tape.netSol >= r.minNetSol &&
      tape.buyers.size >= r.minBuyers &&
      tape.devBuySol <= r.maxDevBuySol &&
      tape.rqSol >= r.minRqSol &&
      tape.rqSol <= r.maxRqSol &&
      runup >= r.minRunup &&
      runup <= r.maxRunup
    ) {
      return 'runner';
    }
    const p = settings.pacer;
    if (
      age >= p.minAge &&
      age <= p.maxAge &&
      tape.netSol >= p.minNetSol &&
      tape.buyers.size >= p.minBuyers &&
      tape.rqSol >= p.minRqSol &&
      tape.rqSol <= p.maxRqSol &&
      runup >= p.minRunup &&
      runup <= p.maxRunup
    ) {
      return 'pacer';
    }
    return null;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;

    // Fold this batch's fills into the positions they belong to. Only the
    // bot's own fills count (harness closes carry a leading underscore);
    // every filled order's transaction fee is part of what the position
    // has cost, so it lands in txPaidSol.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      const pos = open.get(fill.mint);
      if (pos === undefined) continue;
      pos.txPaidSol += Number(fill.tx_fee_lamports) / LAMPORTS_PER_SOL;
      if (fill.side === 'buy') pos.filled = true;
    }

    // Fold this batch's events into the tapes, remembering which mints
    // actually traded: only those can become entries this batch.
    const tradedMints = new Set<string>();
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const tape = tapeFor(event.mint);
        tape.createdSlot = event.slot;
        tape.creator = event.creator;
        tape.createPrice =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        tape.lastPrice = tape.createPrice;
        tape.lastTradeSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        const tape = tapeFor(event.mint);
        const sol = Number(event.sol_amount) / LAMPORTS_PER_SOL;
        tape.entries.push({ slot: event.slot, buy: event.is_buy, sol, user: event.user });
        if (event.is_buy) {
          tape.netSol += sol;
          if (event.user === tape.creator) {
            tape.devBuySol += sol;
          } else {
            tape.buyers.add(event.user);
          }
        } else {
          tape.netSol -= sol;
          if (event.user === tape.creator) tape.devSold = true;
        }
        tape.lastPrice =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        tape.rqSol = Number(event.real_quote_reserves) / LAMPORTS_PER_SOL;
        tape.lastTradeSlot = event.slot;
        tradedMints.add(event.mint);
      } else {
        // Any other event (a completion) ends the mint's tradable life.
        tapeFor(event.mint).complete = true;
      }
    }

    // Forget trades too old to matter, for mints that traded this batch.
    const cutoff = now - keepSlots;
    for (const mint of tradedMints) {
      const tape = tapes.get(mint);
      if (tape !== undefined) {
        tape.entries = tape.entries.filter((entry) => entry.slot > cutoff);
      }
    }

    const pendingMints = new Set<string>();
    for (const pending of state.pending.values()) {
      pendingMints.add(pending.order.mint);
    }
    const marksByMint = new Map(batch.marks.map((mark) => [mark.mint, mark]));

    // Exits first, before any new entry can spend the same cash or slot.
    for (const [mint, pos] of Array.from(open.entries())) {
      const holding = state.positions.get(mint);
      if (holding === undefined) {
        // Nothing held and nothing in flight: the bookkeeping can go.
        if (!pendingMints.has(mint)) open.delete(mint);
        continue;
      }
      // An order is already in flight for this mint; leave it alone.
      if (pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Value against this batch's mark when the harness sent one, else
      // against the curve's latest reserves.
      const mark = marksByMint.get(mint);
      const vq =
        mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt =
        mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const tokens = holding.token_amount;
      const costSol =
        Number(holding.cost_lamports) / LAMPORTS_PER_SOL + pos.txPaidSol + txSol;
      if (tokens <= 0n || costSol <= 0) continue;
      const valueSol = sellProceedsSol(tokens, vq, vt) - txSol;
      const ratio = valueSol / costSol;
      if (ratio > pos.peakRatio) pos.peakRatio = ratio;
      const tape = tapes.get(mint);
      const lastTrade = tape === undefined ? -1 : tape.lastTradeSlot;
      let shouldExit = false;
      if (pos.tier === 'runner') {
        const t = settings.runner;
        shouldExit =
          ratio <= 1 - t.stopLoss ||
          (pos.peakRatio >= 1 + t.trailArm &&
            ratio <= pos.peakRatio * (1 - t.trailGiveback)) ||
          now - pos.openedSlot > t.maxHoldSlots ||
          (lastTrade >= 0 && now - lastTrade > t.staleSlots);
      } else {
        const t = settings.pacer;
        shouldExit =
          ratio >= 1 + t.takeProfit ||
          ratio <= 1 - t.stopLoss ||
          now - pos.openedSlot > t.maxHoldSlots;
      }
      if (!shouldExit) continue;
      if (orders.length >= orderCap) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: tokens,
        max_slippage_bps: 10000,
      });
    }

    // Entries: mints that traded this batch and were never entered before.
    const hopefuls: { mint: string; tier: TierName; netSol: number }[] = [];
    for (const mint of tradedMints) {
      if (decided.has(mint) || open.has(mint) || pendingMints.has(mint)) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      const tier = tierFor(tape, now);
      if (tier !== null) hopefuls.push({ mint, tier, netSol: tape.netSol });
    }
    // Runners first; inside a tier, the strongest inflow wins, and a tie
    // breaks toward the alphabetically first mint so the order is stable.
    hopefuls.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'runner' ? -1 : 1;
      if (a.netSol !== b.netSol) return b.netSol - a.netSol;
      if (a.mint === b.mint) return 0;
      return a.mint < b.mint ? -1 : 1;
    });

    let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let pacerOpen = 0;
    for (const pos of open.values()) {
      if (pos.tier === 'pacer') pacerOpen += 1;
    }

    for (const hope of hopefuls) {
      if (orders.length >= orderCap || slotsLeft <= 0) break;
      const tierSettings = hope.tier === 'runner' ? settings.runner : settings.pacer;
      if (hope.tier === 'pacer' && pacerOpen >= settings.pacer.maxConcurrent) continue;
      let amountSol = tierSettings.stakeSol;
      const sizeCapSol = Number(state.maxBuyLamports(hope.mint)) / LAMPORTS_PER_SOL;
      if (amountSol > sizeCapSol) amountSol = sizeCapSol;
      const affordableSol = freeSol - txSol;
      if (amountSol > affordableSol) amountSol = affordableSol;
      if (amountSol < settings.shared.minBuySol) continue;
      orders.push({
        side: 'buy',
        mint: hope.mint,
        quote_lamports: BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL)),
        max_slippage_bps: settings.shared.buySlipBps,
      });
      decided.add(hope.mint);
      open.set(hope.mint, {
        tier: hope.tier,
        openedSlot: now,
        peakRatio: 0,
        txPaidSol: 0,
        filled: false,
      });
      freeSol -= amountSol + txSol;
      slotsLeft -= 1;
      if (hope.tier === 'pacer') pacerOpen += 1;
    }

    return orders;
  }

  return { onBatch };
}
