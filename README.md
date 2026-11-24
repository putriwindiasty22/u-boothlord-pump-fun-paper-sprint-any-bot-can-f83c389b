# Dip-Bounce Paper Bot — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on make.fun. It trades pump.fun bonding curves on replayed chain data — paper trading only, no real funds.

![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/putriwindiasty22/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)
![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/putriwindiasty22/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)

## Strategy: buy the bounce, not the top

Most pump.fun coins spike, dump, then either die or bounce. This bot buys the bounce:

1. **Watch every curve from birth.** Each coin's tape (trades, prices, wallets) is tracked from its `CreateEvent`.
2. **Wait for a real dip.** Entry needs the price at least 12% below its 300-slot high — but still above 60% of that high, so dead or rugged curves are skipped — and at least 5% off the window low and above the bounce window's own average price, so the price is already recovering.
3. **Confirm fresh buy flow.** The last 40 slots must show net buy flow of at least 0.5 SOL from at least 5 distinct wallets, with the tape ending on a buy. No entry if the creator has sold.
4. **Scale in once.** If the bounce keeps climbing 6% above the entry price with flow still positive, one add-on buy follows.
5. **Exit with discipline.** Stop-loss at −8% of cost, a two-rung take-profit ladder (sell half at +15%, the rest at +35% or on a trailing stop), a hard 400-slot hold limit, exit below the dip low, on a single large sell (≥2.5 SOL), or when buy flow fades.

## Risk guardrails

- Max 4 main positions open at once (harness cap is 5; one slot is kept for pacing probes), max 0.24 SOL per coin, max 5 SOL total exposure.
- Max drawdown guard: small stakes, hard stop-loss, and a 1500-slot hold cap keep any single coin from dragging the account.
- **Guardrail pacing:** a 0.02 SOL probe round trip fires whenever the bot's traded-coin count lags its pace toward 28 coins, so the run clears the competition's minimum bar of 20 coins with ≥0.01 SOL round trips.
- Deterministic: no clock, no randomness, no environment reads — two runs on the same window produce byte-identical action logs.

## Files

- `main.ts` — the strategy (entrypoint, Node 22).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim (byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

## Dev-window result (grade-local, process driver)

On the kit's dev window the bot finished with net PnL **−0.068 SOL** (−0.68% return; 90% interval −0.218…+0.104 SOL), 101 fills over 43 coins, 48 round trips, 10.4% win rate, max drawdown **1.08%** — guardrails met (43 coins hold a round trip of at least 0.01 SOL, drawdown well under the 50% cap). Fees were 0.085 SOL curve + 0.011 SOL tx. The dev window is one small sample and the final 6-hour window is different data, so this is a sanity check, not a forecast.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## Referral

Built with referral code `j9d1a2d9`.
