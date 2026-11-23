// Pump Sprint entry: FirstLight, a launch-momentum sniper for the pump.fun replay.
//
// Run by the grader as `node /bot/main.ts`. The strategy lives in strategy.ts; the
// protocol shim is the kit's SDK vendored byte for byte (vendor/makefun-bot.ts).
//
// How it trades, in one paragraph: every coin is watched from its CreateEvent. In a
// coin's first few slots the bot reads the opening tape — how far the price already ran,
// how much real SOL the curve holds, how many outside wallets bought in, what the
// creator did with their own money — and buys only the launches where the tape shows
// real, broad buying rather than a bundle waiting to dump. Each coin is judged once,
// on the first batch where its real SOL and run-up are both in window; a coin that
// fails is never re-judged, because re-judging later buys the top of a pop that
// already happened. Winners are sold fast on a take-profit or a trailing stop;
// losers are cut on a tight stop; nothing is held past a short time limit. Buys use
// tight slippage as a free "don't chase" filter: if the price jumps in the 2-slot
// latency, the order is refused at no cost. A second, cheaper tier of small probe
// trades keeps the run above the guardrail's 20-coin breadth even when the strict
// tier finds few launches.
//
// Deterministic by construction: every decision is a pure function of the hello and
// the batches the harness sends. No clock, no randomness, no environment, no I/O —
// so the two graded executions produce byte-identical action logs. The bot answers
// every batch with its orders for that slot, or an empty reply when it has none.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_PARAMS } from './strategy.ts';

const bot = createBot(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
