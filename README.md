[![Pump Sprint](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![Rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/emasinves0-commits/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![Reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

# FirstLight — Pump Sprint paper-trading bot

An entry for [Pump Sprint: 12-Hour Paper Trading Dash](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) on [make.fun](https://make.fun): a deterministic pump.fun replay bot trading 10 SOL of paper money on recorded chain data.

## Strategy

**Thesis (from the dev data):** most coins pop in their first slots and then bleed back toward their create price, so buying a fresh launch and holding it loses. But a launch that *already* ran 30%+ in its first 3 slots, on a handful of outside buyers with real SOL behind it and a creator who has not sold, keeps running about a quarter of the time — and the runs that fail mostly drift sideways rather than collapsing. FirstLight buys that continuation, fast, sizes up to the 1%-of-reserve cap (bigger stakes dilute the fixed transaction fee), and cuts the drifters before fees eat them.

Two findings shaped the design, both verified in backtests on the full dev window:

1. **Tight buy slippage (1%) is a free "don't chase" filter.** A buy refused for slippage costs nothing; a buy that fills after the price jumped 10% in the 2-slot latency is buying the top. Tightening slippage from wide open to 1% halved the loss.
2. **Entries are one-shot.** Each coin is judged once, on the first batch where its real SOL and run-up are both in window, using the tape as it stands at that moment. Re-judging later, after more buyers arrive, buys the top of a pop that already happened.

Two tiers share one exit engine:

- **Tier A (the money):** strict launch-momentum entries — young coins (≤ 3 slots old) already up 30%+ on 0–3 outside buyers with 0.3–30 SOL of real reserves, a small creator buy (≤ 2.5 SOL) and no creator sell. Sized up to 0.3 SOL.
- **Tier B (the breadth):** tiny 0.01 SOL probes on looser launches, fired only when the run's distinct-coin count trails the pace the 20-coin guardrail needs.

**Exits:** take-profit (+25%), stop-loss (−5%), a trailing stop once a position is up 10% (exit on an 8% fall from the peak), a hard 20-slot time limit, an instant exit when the creator sells, and a staleness exit. One buy per coin, never re-entered after an exit, one order per decision (splitting an order only multiplies the per-transaction fee).

**Determinism:** every decision is a pure function of the `hello` and the batches the harness sends — no clock, no randomness, no environment, no I/O — so the two graded executions produce byte-identical action logs (verified: the local grader's L1 regrade reproduced byte for byte).

## Results (dev window, 24h, 2–3 Nov 2026)

| Metric | Value |
|---|---|
| Net PnL | **−0.0745 SOL** (−74,508,991 lamports) |
| Drawdown | 0.012 |
| Distinct coins | 52 (all with round trips ≥ 0.01 SOL) |
| Fills / round trips | 104 / 52 |
| Win rate | 23% |
| Fees | 0.0891 SOL curve + 0.0111 SOL tx |
| Guardrails | met |

Honest status: this is the best of every design tested on the full dev window — momentum (−9.42 SOL), reversion (−4.07), the kit sniper tuned (−0.11), completion riding, dip buying, and a popular-launch "lottery" (−0.84) all lost more — but it is still below zero. The signal is roughly break-even before fees (gross +0.004 SOL); the 2.5% round-trip curve fee plus the 2-slot latency leaves almost no room. The bot is deterministic, guardrail-clean, and built from scratch; whether to enter it is a judgement call, not a winning backtest.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the FirstLight strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
