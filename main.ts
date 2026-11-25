// Pump.fun Sharpe Sprint entrypoint: wire the two-speed momentum strategy
// into the replay harness and run it until the harness says done. The
// strategy itself is a pure function of the batches it is handed, so the
// two grading executions agree order for order.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
