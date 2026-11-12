# Balanced Plus: pre-backtest audit and data-availability assessment

Written **before** any change to code, as required. Nothing in the optimiser, the projection engine or the selection logic of Balanced Plus was altered while producing these findings. Evidence comes from reading the code and from a sensitivity probe on the GW11 snapshot (change one input of one player, re-run the pipeline, observe what moves).

## 1. What the implementation actually does

| Component | Implementation (file) | Finding |
|---|---|---|
| Objective | `lib/strategies/balancedPlus.ts`: ILP maximising `0.75·Σ value(XI) + 0.25·Σ value(bench)` under the FPL rules, XI max 2/club, XI eligibility bars, bench target. | As documented. |
| Projection engine | `lib/analytics/expectedPoints.ts` (shared, unchanged): goals/assists rates use `0.8·xG(xA) + 0.2·actual`, shrunk by minutes; bonus, saves, defensive contribution and cards use **actual** per-90 rates; clean sheets / goals conceded use team goals-against and xGA (50/50); form tilt `±10%` on non-appearance points. | The displayed `xPts` come from this engine. |
| Balanced Plus value | per gameweek `max(0, ep − formAdj − goals − assists + goals·rXG/rBlend + assists·rXA/rBlend) × security`, discounted 1/.9/.8/.7/.6 over GW..GW+4. | Only the player's own goals and assists terms are rebuilt on xG/xA. |
| Minutes security | `security = 0.6 + 0.2·startProb + 0.2·min(1, xMin/80)` multiplies a projection that **already** scales every term by expected minutes. | Minutes are counted twice on purpose (stronger preference for secure starters). A heuristic, not a calibrated quantity. |
| Five-gameweek discounting | `Horizon.weights`; later gameweeks reuse the same start probability, vary only by fixtures and the availability decay. | Fixtures matter, minutes/availability news does not evolve. |
| Captaincy | `pickCaptaincyIndependently`: highest **raw** `ep` of the gameweek in the XI; vice = best secure starter from another club. | "Independent" of the squad objective, but the raw `ep` still contains the form tilt and the 20% realised blend. |
| Report | `lib/strategies/report.ts` reuses the standard report; players' `projection.xPts` and `breakdown` are the raw engine output. | See B below. |
| Tests | `tests/balancedPlus.test.ts` pins the squads of Balanced/Safe/Aggressive and checks Balanced Plus rules. | Tests assert the value function ignores form and realised goals/assists; **no test asserted what the displayed numbers contain**. |

## 2. Inconsistency A: xG/xA versus realised returns

Probe (GW11, one player's input changed, everything else fixed). Cells show the change in the **Balanced Plus objective value** / the change in the **displayed GW11 xPts**:

| Input changed | Haaland | Tavernier | Van Hecke | Trafford (GK) | Gabriel |
|---|---|---|---|---|---|
| goals ×2 | +0.01 / +0.46 | 0.00 / +0.31 | 0.00 / +0.21 | 0.00 / 0.00 | 0.00 / +0.07 |
| assists +3 | 0.00 / +0.11 | 0.00 / +0.11 | 0.00 / +0.16 | +0.06 / +0.11 | 0.00 / +0.11 |
| **bonus ×2** | **+0.82** / +0.87 | **+0.70** / +0.75 | **+0.37** / +0.45 | **+0.70** / +0.67 | **+0.30** / +0.31 |
| **defensive contribution ×2** | +0.02 / +0.02 | **+0.89** / +0.91 | **+0.98** / +1.01 | 0.00 / 0.00 | **+0.99** / +1.03 |
| **saves ×2** | 0.00 | 0.00 | 0.00 | **+0.79** / +0.86 | 0.00 |
| **yellow cards +3** | −0.19 / −0.19 | −0.18 / −0.19 | −0.18 / −0.18 | −0.18 / −0.18 | −0.18 / −0.18 |
| form 1 → 12 | 0.00 / +0.30 | 0.00 / +0.29 | 0.00 / +0.24 | +0.01 / +0.21 | 0.00 / +0.09 |
| xG ×1.3 | +0.47 / +0.43 | +0.35 / +0.32 | +0.19 / +0.21 | 0.00 / 0.00 | +0.16 / +0.13 |

Conclusions:

1. **Which calculations use actual returns**
   - *Displayed xPts*: goals and assists via the 20% realised blend; bonus, saves, defensive contribution, cards (fully actual per-90 rates); team goals-against (50% actual) for clean sheets / goals conceded; minutes and starts; the positional priors are built from blended totals.
   - *Balanced Plus objective*: **excludes the player's realised goals and assists** (the goals/assists rows are ≈ 0.00 in the objective column). It **still includes realised bonus points, defensive contribution, saves, yellow/red cards, team goals conceded, starts and minutes.** Bonus and defensive contribution move the objective as much as they move the raw projection.
2. The report's rule "realised goals and assists are not used" is **true for the objective's goals/assists terms only**. Describing it as "built on xG/xA rather than recent form" without that qualification overstates it: a defender with a high realised defensive-contribution rate, or a forward with many bonus points, is rewarded on realised data.
3. **The displayed xPts are not the optimiser's objective.** They come from the shared engine (blend + form). The 'xPts' of a Balanced Plus player in the PDF is therefore *not* the number Balanced Plus maximised; its objective value is a separate, five-gameweek, adjusted quantity that the report never printed for players.
4. Residual: the xG-only rates are still shrunk to positional priors that include realised goals (tiny), and the ratio is clamped to [0.5, 1.5].

## 3. Inconsistency B: form adjustment

- The form tilt is removed **only inside the optimiser's value function** (form 1 → 12 changes the objective by 0.00, the displayed xPts by +0.09 to +0.30).
- The **displayed** projections and the per-player `breakdown` still contain `formAdj`: 250 of the 412 players with positive xPts have a non-zero value (mean |formAdj| = 0.03 xPts), which is what the GW11 report shows.
- **Captaincy uses the displayed (form-tilted) projection**, so recent form can still influence which player is captain and vice-captain. The report's "no player is selected on form alone" is true for the *squad and XI* but not for the *armband*.
- The metric "Recent-form tilt inside XI xPts: 0.21 vs 0.99" measures the displayed tilt of the chosen players, not what the optimiser used.

## 4. Decisions arising from the audit

- **The projection engine is not changed.** Balanced, Safe and Aggressive are not changed.
- **Balanced Plus' selection logic is not changed** (changing it after seeing these results, and before testing, would be tuning). The backtest evaluates it exactly as implemented, with the form/realised-return behaviour above.
- **What is corrected:** the report's methodology text (rules, definition and a new "what is and is not realised data" section) is rewritten to state precisely: objective vs displayed xPts, which terms still use realised data, form removed from the objective only, captaincy using the displayed projection. A test now asserts the text and the behaviour agree.
- Ablations (objective with/without minutes security, with/without the club cap, with raw `ep` instead of the adjusted value) are run **as descriptive sensitivity analysis**, not to pick parameters.

## 5. Historical data availability

### What the repository already has
- Current season (2026/27) only: GW1-10 per-player history via the FPL API (`element-summary`, cached by the earlier backtest). Only **one usable five-gameweek window** (it needs 5 prior and 5 following gameweeks). Far too few for inference.
- The FPL API serves only the current season; it has **no archive**.

### What was added (real data, nothing synthesised)
The public dataset **vaastav/Fantasy-Premier-League** (per-gameweek player rows scraped from the FPL API each gameweek, plus fixtures and teams) was downloaded and **frozen** in `data/historical/` as gzip files with SHA-256 hashes and the upstream commit (`d7b05b51…`) in `data/historical/manifest.json`. The backtest reads only these files, so results are reproducible offline.

| Season | GWs | Rows | xG/xA | starts | defensive_contribution | Assessment |
|---|---|---|---|---|---|---|
| 2022-23 | 37 (one GW missing) | 26,505 | **absent GW1-14** (0% of played rows), present from GW15 | yes | no | **Partial**: windows are only clean once ≥ 6 gameweeks of xG exist (start ≥ GW21). Flagged. |
| 2023-24 | 38 | 29,725 | ~77% of played rows (normal) | yes | no | Clean. **Development season** |
| 2024-25 | 38 | 27,605 | yes | yes | no | Clean. **Held-out evaluation** |
| 2025-26 | 38 | 29,757 | yes | yes | yes (scoring on) | Clean. **Held-out evaluation** |
| 2021-22 | 38 | n/a | **no xG/xA, no starts** | no | no | Excluded (the model needs xG/xA/starts). |
| 2026-27 (live) | 10 so far | API | yes | yes | yes | Not used (1 usable window). |

### Point-in-time properties of each input

| Input | Source column | Point-in-time? | Handling |
|---|---|---|---|
| Minutes, starts, goals, assists, xG, xA, xGC, bonus, saves, cards, defensive contribution | per-GW rows | **Yes**: rows are per gameweek, so the cumulative values at deadline *t* use only rounds < *t* | cumulative sums of rounds < t |
| Price | `value` of the player's latest row before *t* | **Yes, but up to ~7 days stale** (price at the previous deadline) | used for the £100m budget for every strategy equally |
| Ownership | `selected` (latest row < t), normalised by Σselected/15 | **Yes** | derived managers = Σ selected / 15 |
| Team goals for/against | fixtures finished before *t* | **Yes** | existing `deriveTeamStats` |
| Fixtures of GW t..t+4 | `fixtures.csv` `event` | **Not strictly**: the file holds the *final* schedule, so a fixture postponed and rearranged later appears in its final gameweek, which was not known at the earlier deadline | flagged; affects rearranged/double/blank gameweeks only (windows containing a gameweek with no fixtures in the data are excluded) |
| FDR (`team_h_difficulty`) | `fixtures.csv` | possibly revised in-season | **not used** in any selection or projection (display only) |
| **Injury / suspension / chance of playing** | *none* | **No point-in-time source exists** (FPL's `status`/`news` are overwritten in place; the archive has none) | **not used**. A *proxy built from past minutes only* is applied identically to all four strategies: a player with 0 minutes in each of his club's last two matches is treated as doubtful (0% for the next gameweek). A sensitivity run uses no proxy (everyone available). Real injury news is never used. |
| Squad / team of a player | latest row | team changes mid-season appear when the player's rows change | a player with no row before *t* is unknown at *t* (new signings invisible until they have a row), conservative and identical for all strategies |
| `form` | derived: mean points of the last 3 appearances | derived, point-in-time | approximates FPL's 30-day form |

### Leakage controls
1. Every feature at deadline *t* is a function of rows with `round < t` (verified by a test that perturbs future rows and shows selections do not change).
2. Evaluation outcomes (actual points, minutes) are read only after selections are fixed.
3. No end-of-season statistic is used; no current-season file is used for historical decisions.
4. The assumptions above are recorded per run in the results JSON.

### Known contamination that cannot be removed
- Final fixture schedule (rearranged fixtures).
- The upstream dataset is a third-party scrape: row completeness/accuracy is assumed, not verified against FPL.
- Player prices are one deadline stale.
- 2022-23 xG only from GW15.

## 6. Evaluation design (frozen before running)
- **Unit = a five-gameweek window**: at deadline *k* each strategy buys a legal 15-man squad (£100m, 3 per club) from point-in-time data and holds it for GW *k…k+4*; for each gameweek the same strategy's own lineup rule picks the XI, bench order and captain from point-in-time data at that gameweek's deadline. Scoring applies FPL auto-substitutions and the vice-captain rule.
- **Warm-up**: windows start at GW 6 (≥ 5 gameweeks of history) and end at GW 34. 29 rolling windows per season; 6 non-overlapping.
- **Splits**: development = 2023-24 (harness verification only); held-out evaluation = 2024-25 and 2025-26 (primary conclusion); 2022-23 was attempted and later excluded by a data-quality gate (see the backtest report); 2026-27 has a single usable window and is not used.
- **No tuning**: strategy parameters are those already in the repository; no parameter was changed after seeing any result. Sensitivities are descriptive.
- **Inference** uses non-overlapping windows (independent-ish) and a moving-block bootstrap for the overlapping series; differences of a few tenths of a point are not claimed as evidence. An effect is labelled evidence only if both 95% intervals exclude zero.

**Addendum written after the first full run (for transparency).** (1) 2022-23 turned out to lack `starts` for GW1-15 (the xG gap was already known), so Balanced Plus found no legal squad in it; an automatic data-quality gate now rejects windows whose history lacks starts/xG, and 2022-23 is excluded. (2) One redundant sensitivity variant (identical by construction to another) was removed. Neither changes any strategy's selection logic or parameters.
