# Balanced Plus (fourth strategy)

> **Update after the audit and rolling backtest:** the wording of requirements 3 and 6 below was corrected (the objective and the displayed xPts differ; see [BALANCED_PLUS_AUDIT.md](BALANCED_PLUS_AUDIT.md)). Historical validation over two held-out seasons found **no established advantage over Balanced** (competitive, pooled +5.6 points per five-gameweek window, 95% intervals include zero, seasons disagree in sign): [BALANCED_PLUS_BACKTEST.md](BALANCED_PLUS_BACKTEST.md). The GW11 comparison below is a single snapshot, not evidence of better performance.

Sits next to Balanced, Safe and Aggressive. It is **additive**: `lib/strategies/*` reuses the projection engine and report renderer, and the existing optimiser and reports are unchanged (a regression test pins the exact squads that Balanced, Safe and Aggressive produce).

- Page: `/strategies/balanced-plus` (nav: **Balanced Plus**) · JSON: `GET /api/strategies/balanced-plus?gw=` · PDF: `GET /api/strategies/balanced-plus/report?gw=`
- Generate the file: `npm run balanced-plus` → `docs/samples/gw11-balanced-plus-report.pdf` (+ `…-comparison.json`)
- Sample: [`docs/samples/gw11-balanced-plus-report.pdf`](samples/gw11-balanced-plus-report.pdf) · screenshot: [`screenshots/25-balanced-plus.png`](screenshots/25-balanced-plus.png)

## How each requirement is implemented

| # | Requirement | Implementation | Enforced / tested |
|---|---|---|---|
| – | Same snapshot and £100m | One `Dataset`, `rules.budgetTenths = 1000`; the three others are produced by the unchanged optimiser from the same dataset | cost ≤ £100m asserted for all four |
| 1 | Max 2 per club in the XI | ILP constraint `Σ s_i[club] ≤ 2` per club (squad limit stays 3), independently re-checked after solving | XI max club = 2; the three others reach 3 (BOU x3) on this snapshot, so the cap is binding |
| 2 | High expected minutes, secure starters | XI membership requires start probability ≥ 75%, ≥ 60 expected minutes, availability ≥ 90%; value is scaled by `0.6 + 0.2·start + 0.2·min(1, xMin/80)` | every starter meets the bars; rotation-risk test |
| 3 | xG, xA, xGI (not assists alone) | Inside the **objective**, the player's own goal and assist terms are rebuilt from **xG and xA only**. Bonus, defensive contribution, saves, cards, team goals conceded and minutes still use realised data, and the **displayed** xPts keep the shared model's 80/20 xG-realised blend (see the audit) | doubling realised goals/assists leaves the value unchanged; raising xG or xA raises it; assist share of XI xGI < 40% |
| 4 | Next five gameweeks | Value = Σ discounted xPts over GW11-15, weights 1 / 0.9 / 0.8 / 0.7 / 0.6 (same as the transfer engine) | formula test, ranking differs from GW11-only, fixture-swing test |
| 5 | Strong playable bench | Outfield subs need ≥ 50% start probability; bench weighs 25% of a starter (Balanced 12%); bench GW xPts target ≥ 12, relaxed stepwise only if infeasible (met at 12 here); fit substitute keeper first | bench rules + xPts ≥ Balanced's bench |
| 6 | Not form-driven | The recent-form tilt is **removed from the objective only**. Displayed xPts, the breakdown and captaincy still include it | changing a player's form from 1 to 12 changes the raw projection but not the Balanced Plus value |
| 7 | Independent captaincy | Captain = highest **displayed** (raw model, form-tilted) xPts in the XI, not the squad value; vice = best remaining secure starter (≥ 85% start) from a **different club** to the captain | captain = argmax raw xPts; vice club ≠ captain club; synthetic club-mate test |

## Result on the current snapshot (GW11, same data as the other three)

| | Balanced | Safe | Aggressive | **Balanced Plus** |
|---|---:|---:|---:|---:|
| GW11 xPts (XI + captain) | 57.14 | 56.67 | 56.74 | **55.55** |
| 5-GW xPts (sum) | 276.19 | 275.92 | 271.98 | **276.60** |
| 5-GW xPts (discounted) | 221.13 | 220.97 | 218.02 | **221.20** |
| Max from one club in XI | 3 (BOU) | 3 (BOU) | 3 (BOU) | **2** |
| XI avg start prob | 96% | 98% | 97% | 98% |
| Bench xPts | 15.8 | 16.3 | 15.5 | 15.8 |
| XI outfield xGI/90 | 4.35 | 4.68 | 4.81 | **5.39** |
| Form tilt inside XI xPts | 0.99 | 0.86 | 0.88 | **0.21** |
| Captain / vice | Haaland / Isak | same | same | same |

**Honest reading:** the club cap and secure-minutes bar cost about **1.2-1.6 xPts in GW11** (Balanced Plus is the lowest of the four for the single gameweek). Over five gameweeks it is level with Balanced and Safe (+0.4 / +0.7 over the sum, +0.07 / +0.23 discounted) and ahead of Aggressive (+4.6), with more underlying attacking output and far less form dependence. These are model estimates on one snapshot, not a proven edge. Captain and vice come out the same as the other strategies because Haaland and Isak top the raw xPts in every XI; the independence shows in the rule (and in tests), not in a different pick this week.

Gameweeks 12-15 use each squad's best XI (unconstrained) so all four are measured the same way; the 2-per-club rule governs the XI shown for the selected gameweek.

## Changed-player explanations

For each existing strategy, every player who differs is explained (`explainChanges`):

- **Swaps** (out → in, matched by position): why the old player does not fit (club overload with the names of the players involved, below the minutes/start bar, form-tilt points removed, realised returns above xG/xA, lower five-gameweek value, or an honest "squad-level trade-off" line when the new player is not individually better) and why the new player fits (start probability and minutes, underlying xGI/90, five-gameweek value and fixture difficulty, club count in the XI), plus GW11 xPts, five-gameweek value, role and price.
- **Role changes** (same player, XI ↔ bench).
- **Captaincy** (captain and vice versus the baseline).

Each stated reason is checked against the data in the tests (e.g. a "club cap" explanation is only emitted when the baseline XI really has 3+ from that club). Reasons are generated from numbers, not from a language model.

The PDF uses the **existing report format** (all 15 players, XI, bench, captains, stats, xPts breakdown, fixtures, replacement shortlist, confidence, model notes, printed + attached JSON) with a **strategy definition and comparison appendix** inserted before the structured data; the JSON gains `strategy` and `strategyComparison` (metrics for all four, every swap/role change with reasons).

## Limitations

- One snapshot, one gameweek: the strategies differ by ±1-2 xPts, which is inside the model's noise (backtest MAE per player is 2.3 points). Do not read the ranking as proof.
- The squad-level optimum can swap players whose individual values are similar; those cases are labelled "squad-level trade-off".
- Thresholds (75% / 60 min / 50% / bench target 12 / weights) are heuristics, not fitted.
- The XI club cap applies to the selected gameweek's XI; later gameweeks are scored with each squad's best XI.
