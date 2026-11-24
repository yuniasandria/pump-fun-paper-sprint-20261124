# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yuniasandria/pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yuniasandria/pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A [make.fun](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) entry for **Pump.fun Paper Sprint: Any Bot Can Win**: a program that paper-trades pump.fun on a 6-hour replay, highest net PnL takes the pot.

## Strategy

Buy every new coin once, as early as the size cap allows a meaningful amount (0.05 SOL stake, one buy per coin, never a re-buy), then exit on a plan: take-profit at 2x cost, stop-loss at 0.5x cost, time stop after about 2 hours. All decisions are deterministic BigInt ratio math on the curve's virtual reserves — no clock, no environment, no randomness — so two runs produce byte-identical action logs.

## How it works

`main.ts` (Node 22, TypeScript, zero dependencies besides the vendored SDK shim in `vendor/makefun-bot.ts`) speaks the `agent-fun/replay/v2` protocol on stdin/stdout: one reply per batch, orders decided per slot.

## Local grade (dev window)

`node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree` — net PnL -0.288 SOL on the dev window (79 coins, 79 round trips, 15% win rate, guardrails met), best of the tested variants (no-TP -0.629, TP 1.5x -0.357, tighter SL -0.565). The final window is a fresh 6 hours, so the dev score is a behavior check, not the result.

## License

MIT — see [LICENSE](LICENSE).
