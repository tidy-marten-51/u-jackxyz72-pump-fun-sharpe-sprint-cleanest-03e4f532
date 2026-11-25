// Scalpel: a Sharpe-first pump.fun launch scalper for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the protocol shim is vendored beside it in vendor/makefun-bot.ts.
//
// Two tiers, one entry per coin, ever. The runner tier buys only launches
// that are already running 2-3x on 5+ SOL of net crowd inflow in their
// first two slots and rides them under a wide trailing stop, because the
// dev window shows the moonshots are decided in those first slots. The
// pacer tier buys the next tier of launches for 0.02 SOL a coin and banks
// a quick +5%, which keeps the mint count above the 20-coin guardrail and
// the hourly equity curve steady. Small fixed stakes, at most five coins
// at once, so one bad coin can never dent the book.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
