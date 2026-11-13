# Season Long strategy

Fifth strategy in Team Builder: **maximise expected points across the remaining season** (default: selected gameweek → GW38). Balanced, Safe, Differential and Balanced Plus are unchanged short-horizon optimisers (frozen files and pinned outputs are still verified by the test suite).

## How it works
Code: `lib/strategies/seasonLong.ts` (model + optimiser), `seasonLongServer.ts` (horizon cache), `app/api/strategies/season-long/*`.

1. **Per-gameweek projection** – every remaining GW is projected with the same shared engine (`projectPlayer`) used by all strategies: fixtures (blank/double GWs counted as scheduled), opponent and team strength, xG/xA, bonus, minutes and start probability.
2. **Availability trajectory** – fit players start at 100% and settle to `1 − 0.12` (calibrated future-absence haircut); injured/doubtful players start at their chance of playing and recover exponentially (time constants: doubtful 3, injured 8 GWs); suspended/unavailable players stay at 0 until the data says otherwise.
3. **Time discount** – gameweek *j* from now weighs `0.93^j` (not 5 GWs × N). Later gameweeks count less because fixtures, form, injuries and prices are less certain.
4. **Optimiser** – ILP over the 15-man squad: £100m (or the budget box), 2/5/5/3 positions, ≤3 per club, formation preference, discounted value for the XI plus bench weight 0.30, minimum start probability/availability for the XI core and bench cover, optional ownership cap.
5. **This week's XI / bench / captain** – the squad is fixed by season value, but the XI, bench order and captain/vice are picked on the shared next-GW projection, so the displayed "this GW" numbers are comparable with every other strategy.
6. **Weekly transfers** (My Team → horizon toggle "Rest of season") – the existing transfer engine (FPL free-transfer/hit rules, selling prices, bank) run over the season horizon; decision thresholds are scaled by `discountSum/4` so it is no more trigger-happy than the 5-GW version. It never forces a transfer; options show hit cost and remaining-season gain.

## How the projections differ from Balanced
Balanced uses a 5-GW horizon with form-tilted scores. Season Long uses 28 discounted GWs, availability/injury recovery, no form tilt on the objective, and bench weight 0.30. Expect fewer "this week" points and more rest-of-season value (see test `long-horizon optimiser`).

## What is data and what is assumption
Reliable: prices, positions, fixtures, current availability/news, season minutes/xG/xA. Assumptions (shown in the UI under *Assumptions and limitations*): future injury/rotation, constant team strength, one fixture per GW unless scheduled, no price changes, no future chips, fixtures may be rearranged.

## Calibration (development season 2023-24 only)
`npm run backtest:calibrate-sl` → `docs/backtest/season-long-calibration.json`. `futureAbsence = 0.12` chosen as the value with ~zero long-lead bias (bias 0.008); MAE was *not* used because it rewards shrinking skewed, zero-heavy distributions. Fixture-trust blending slightly hurt, so it is 1 (off). Parameters were frozen (`data/backtest-frozen-season-long.json`) before the held-out seasons were run.

## Backtest (`npm run backtest:sl`)
Point-in-time, no look-ahead, held squad per window (no weekly transfers), held-out seasons 2024-25 and 2025-26 pooled, paired against Balanced and Balanced Plus. Files: `docs/backtest/season-long-*.{json,csv}`.

| Windows | Season Long vs Balanced (pts/window) | non-overlapping 95% CI | block-bootstrap CI | Season Long vs Balanced Plus |
|---|---|---|---|---|
| 5 GW (58) | +10.2 | [−16.9, +19.7] | [+3.7, +19.9] | +4.6 (CI incl. 0 both ways) |
| 10 GW (48) | +23.4 | [−96.1, +60.7] | [+18.6, +35.9] | +11.1 (non-overlap CI incl. 0) |

Per season vs Balanced (5 GW): 2024-25 +18.3, 2025-26 +2.1; (10 GW) +24.5, +22.4 — same sign everywhere. Safe and Aggressive were not better than Balanced.

**Verdict: positive point estimates, consistent in sign, but the conservative (non-overlapping) intervals include zero and the sign tests are not significant, so superiority is *not established*.** Ablations (no discount, steeper discount, 5/10-GW horizon, no haircut, fixture blend) all land within ~3 points of the full model with CIs including zero, so none of the design choices is individually proven to matter.

**Limitations:** a fair season-long backtest would simulate weekly transfers (with free-transfer/hit rules and real price changes) over a whole season, which the frozen historical data (no price history, no pre-season fixture lists, 2022-23 lacks xG) cannot support; fixed-hold 5/10-GW windows only test a slice of the horizon and ignore the strategy's transfer workflow. Only two held-out seasons; xG-based features exist only for them.

## Tests
`tests/seasonLong.test.ts` (29 tests: horizon/discount, availability, optimiser legality, bench reasons, transfer legality/no forced moves, API routes, pinned Balanced output) plus `npm run e2e:season-long`.
