[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tidy-marten-51/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tidy-marten-51/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Scalpel — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun (agent-fun/replay/v2, `main.ts` on Node 22). It trades a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio.

## Idea

Most new curves die, but the ones that move spike first — and the dev window shows the moonshots are decided in a coin's first two slots. So the bot runs two tiers, one entry per coin, ever:

- **Runner tier** — buys only launches already running 2–3x on 5+ SOL of net crowd inflow from 3+ distinct buyers in their first two slots, stakes 0.15 SOL, and rides them under a wide trailing stop (arms at +25%, exits on a 40% pullback, max hold 300 slots). Wins only ~18% of the time, but its winners are 2–5x runners that pay for the whole book.
- **Pacer tier** — buys the next tier of launches (age 1–2 slots, 3+ SOL net inflow) for 0.02 SOL a coin and banks a quick +5% or cuts out after 30 slots. Roughly breakeven on its own; its job is the 20-distinct-mint guardrail and a steadier hourly equity curve.

Small fixed stakes, at most five coins at once, so one bad coin can never dent the book. Pure function of the batches it is fed: no clock, no randomness, no I/O, deterministic across runs.

## Local grade (dev window)

`node cli/makefun.mjs grade-local --kit . --bot . --driver process` (run from the kit dir):

| net PnL | Sharpe (hourly) | Sortino | max drawdown | round trips | distinct mints | fills |
| --- | --- | --- | --- | --- | --- | --- |
| +0.264 SOL | +0.068 | +0.134 | 6.1% | 274 | 274 | 548 |

Compliant (drawdown ≤ 50%, ≥ 20 mints), deterministic — two runs produce the same `action_log_sha256`. For reference, every shipped pilot baseline loses on this window (momentum −9.44 SOL, reversion −3.99, sniper −0.50, equal-weight −0.02 and non-compliant).

## Layout

- `main.ts` — entrypoint: runs the strategy through the protocol shim.
- `strategy.ts` — the two-tier strategy (all tunable parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the agent-fun/replay/v2 wire shim (stdin/stdout JSON lines, state tracking, order validation).
- `LICENSE` — MIT.
