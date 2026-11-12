# Expected-points model

`lib/analytics/expectedPoints.ts` · deterministic, no randomness, no LLM.

## Principle

Expected points are built **bottom-up from FPL's own scoring table** (`game_config.scoring`), one term per scoring event, summed over the player's fixtures in the gameweek (blank gameweek = 0, double = 2 fixtures):

```
ep = appearance + goals + assists + cleanSheet + goalsConceded + saves + defensiveContribution + bonus + cards + formTilt
```

| Term | Formula (per fixture) |
|---|---|
| appearance | `shortPlay·P(play) + (longPlay−shortPlay)·P(60+)` |
| goals | `goalRate/90 · expMinutes/90 · fixtureMultiplier · pts_goal[pos]` |
| assists | same with `assistRate`, `pts_assist` |
| clean sheet | `e^{−λ_conceded} · P(60+) · pts_cs[pos]` (Poisson P(0 goals)) |
| goals conceded | `E[⌊G/2⌋], G~Poisson(λ_conceded) · P(60+) · pts_gc[pos]` |
| saves (GK) | `E[⌊S/3⌋], S~Poisson(saves/90 · mins · opponentAttack) · pts_save` |
| defensive contribution | `pts_dc[pos] · P(count ≥ threshold) · P(play)` (normal approx, thresholds DEF 10 / MID,FWD 12; the API exposes only the points, thresholds are constants) |
| bonus | `bonusRate · mins · (0.5 + 0.5·attackMultiplier)` |
| cards | `(yellow/90·−1 + red/90·−3)·mins` |

Position-specific values (a DEF goal = 6, MID 5, FWD 4; clean sheets 4/1/0) come from the API, not constants.

## No double counting

- Goal rate uses **one blended rate**: `0.8·xG + 0.2·actual goals` (assists likewise). Goals and xG are never added as separate events, and xGI is never added on top of xG + xA.
- Per-90 rates are **shrunk to the positional prior** with reliability `r = minutes / (minutes + 450)`, so 90 minutes of a lucky 3-goal game barely moves the estimate (reliability penalty for small samples).

## Minutes and availability

- `startProb = 0.7·(starts/teamGames) + 0.3·(minutes/(teamGames·90))`.
- Availability from `status` and `chance_of_playing_next_round`: `u/s/n → 0`; doubtful with no number → 0.5; for gameweeks beyond the next one, uncertainty decays toward a coin flip rather than assuming the news persists.
- `P(play)`, `P(60+)`, expected minutes derive from both. Unlikely starters therefore get a large penalty automatically.
- The app only states injury/availability facts that the API provides (it quotes `news`).

## Fixtures

- Team attack/defence rate = blend of actual goals and xG (for/against) per game, shrunk toward league mean (`4` pseudo-games).
- Attack multiplier = `(oppConcedes/leagueAvg)^0.8 · (home 1.10 | away 0.90)` (dampened to avoid overreacting).
- Expected goals conceded for clean sheets = `leagueAvg · √(oppAttack · ownDefence) / venue`.
- FPL's own FDR (1–5) is shown in the UI; the model uses the measured strengths.

## PRD weights: how they map

The brief lists suggested weights (attacking 35%, minutes 20%, fixtures 15%, form 10%, defence 10%, bonus 5%, differential 5%) and says they are "initial, not official". A weighted sum of unlike quantities would not yield *expected points*, so the app does this instead:

| PRD factor | Implementation |
|---|---|
| Attacking returns, defence, bonus | Real scoring terms above (their share emerges from the maths, e.g. attacking ≈ 35–55% of a forward's `ep`) |
| Minutes / starting probability | Multiplies every term via `P(play)`, `P(60+)`, expected minutes |
| Fixture difficulty | Attack multiplier and clean-sheet/saves λ |
| Recent form (10%) | **Bounded tilt**: `±10% × clamp((form − ppg)/max(ppg,2), −1, 1)` on non-appearance points, only with ≥270 minutes |
| Differential (5%) | **Not part of `ep`.** Only affects the optimiser's selection `score` (`1 + diff·0.35·rarity`, rarity = 1 at 0% owned → 0 at ≥25%) in Differential mode or via the slider. `ep` shown to users is never inflated by ownership |

## Modes

`score` is what the optimiser maximises; `ep` is the honest projection.

| Mode | Selection score |
|---|---|
| Balanced | `ep · (0.9 + 0.1·startProb)` |
| Safe | `ep · (0.5 + 0.5·startProb) · (0.8 + 0.2·confidence)` |
| Differential | `ep · (0.85 + 0.15·startProb) · (1 + diff·0.35·rarity)`, default diff 0.6 |

"Favour fixture runs" blends `ep` of GW, GW+1, GW+2 with weights 1 / 0.5 / 0.35 into the selection score (not into displayed `ep`).

## Confidence

`0.45·sampleSize(min(1, minutes/1350)) + 0.25·availabilityCertainty + 0.30·startProb` → high ≥ 0.7, medium ≥ 0.45, else low.

## Consistency

`lib/analytics/consistency.ts` uses per-gameweek history (element-summary) to label a player **consistent / streaky / hauls**: share of games with a return, and how concentrated recent points are in the best match. Shown on the player page (not used in `ep`).

## Backtesting

`npm run backtest` (`scripts/backtest.ts`):

1. Fetch every player's per-gameweek history (cached in `.cache/history`).
2. For each target gameweek `k`, rebuild a dataset from **rounds < k only**: cumulative minutes/starts/xG/xA/bonus/saves/etc., price after round k−1, ownership then, team goals for/against from fixtures finished before `k`.
3. Run the same projection and optimiser; compare with actual points.
4. Baselines: points-per-game × fixtures; captain = best PPG; squad = optimiser fed PPG.

Latest run (GW5–GW10, 1,338 player-gameweeks):

| | Model | PPG baseline |
|---|---:|---:|
| MAE | 2.30 | 2.57 |
| RMSE | 2.99 | 3.28 |
| Bias | +0.05 | +0.62 |
| Captain avg pts | 5.33 | 2.67 |
| Squad avg pts (XI + C×2, no auto-subs) | 52.0 | 45.5 |

Per-gameweek detail is in `docs/backtest-results.json`. The model beat the baseline's error every gameweek tested and is well calibrated (bias ≈ 0; the PPG baseline over-predicts by 0.6). Squad/captain results over six gameweeks are noisy (one 0-point captain swings the average); don't over-read them.

**Caveats:** news/availability isn't point-in-time (everyone treated as available for both sides); no auto-substitutions; small gameweek sample; weights are heuristics, not fitted. Next steps: fit shrinkage constants and form weight by minimising backtest MAE; add recent-starts from history to the live model.
