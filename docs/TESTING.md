# Testing

```bash
npm test            # 224 tests, ~12 s
npm run typecheck
npm run screenshots # E2E in headless Chrome against a running app
```

Tests run against a **real FPL snapshot** committed in `tests/fixtures/` (bootstrap-static + fixtures), so they're deterministic and offline.

| Suite | Covers |
|---|---|
| `normalizer.test.ts` | numeric-string parsing, tenths pricing, rules/scoring read from API, missing fields, schema errors, derived team stats, next-gameweek detection |
| `expectedPoints.test.ts` | Poisson/normal maths, shrinkage, home>away, weak>strong opponent, double gameweek, blank gameweek, unavailable=0, rotation penalty, chance-of-playing scaling, position-specific scoring, no goal/xG double count, GK-only saves, CS only for DEF/GK/MID, confidence, explanations only data-backed, differential affects score not `ep`, fixture-run blending, consistency labels |
| `optimizer.test.ts` | formation enumeration (exactly the 8 legal ones), invalid-squad detection (size, quota, duplicates, budget, club limit), valid squad in all 3 modes, determinism, beats a points-per-game squad on the same constraints, custom/clamped budget, preferred formation, ownership cap, infeasible → error, no unavailable players, differential lowers ownership, every gameweek works, speed, best-formation optimality vs brute force, captain/vice rules, alternatives legality, accurate Δ points, club-limit and budget enforcement |
| `api.test.ts` | every route handler: success shapes, validation (400), infeasible (422), 404, replace→evaluate round trip |
| `client.test.ts` | 15-min cache, request de-duplication, stale-on-failure, "being updated" text body, sample fallback |
| `share.test.ts` | link round-trip (unicode), garbage rejection |
| `openapi.test.ts` | spec is OpenAPI 3, documents exactly the implemented routes, no dangling `$ref`s |
| `season.test.ts` | selling price (profit halved, rounded down; losses in full), free-transfer roll-over/cap/hit reset/Wildcard & Free Hit banking, −4 per extra transfer, chip windows (two sets), one chip per GW, Free Hit GW1 and consecutive rules, `applyPlan` (legal transfer, selling-price funding, bank, club limit, position quota, duplicates, hits, chip clashes), Wildcard permanent & hit-free, Free Hit temporary within selling value + bank, `rollForward` (carry, banking, FH revert, illegal plan stops), `editPlan`, import replay and free-transfer derivation |
| `seasonTransfers.test.ts` | every recommended plan is legal in the rules engine, net maths, deductions, save-on-optimal-squad (no forced transfers), hit margin, bank/selling-price limits, five alternatives per player, flagged players surfaced, Bench Boost/Triple Captain maths, chip strategy verdicts and expiry, replacement candidates and extra-hit flagging |
| `apiSeason.test.ts` | season routes (evaluate/transfers/chips/alternatives/freehit/wildcard), actual untouched, carry-forward, bad input, import of a mocked FPL team (rebuild, Free Hit week ignored, bank, derived free transfers, captain, chips, 404, no credentials sent) |
| `balancedPlusBacktest.test.ts` (26) | SHA-256 proof that the optimiser/projection-engine sources are unchanged; Balanced Plus defaults unchanged by the ablation options; **report text matches behaviour** (objective ignores realised goals/assists/form but responds to bonus/defensive contribution/saves/cards; the PDF explains objective vs displayed xPts); **leakage**: corrupting all data from the deadline onward leaves point-in-time data, squads and first lineups identical; fixtures/prices time-correct; availability proxy; data-quality gate rejects 2022-23; harness invariants (legal squads, 5 gameweeks, unchanged optimiser, ≤2 per club, deterministic); FPL auto-sub and vice-captain scoring; statistics helpers; committed results were produced by the frozen code and data and are internally consistent; **release hygiene**: snapshots match the manifest and are documented, every UI/PDF limitation is also in the backtest report, the strategy API/PDF/page expose objective vs displayed xPts |
| `balancedPlus.test.ts` (30) | regression pin of the unchanged Balanced/Safe/Aggressive squads; Balanced Plus: legal squad at £100m, XI max 2 per club (and the others break it), secure-starter bars, playable bench, no unavailable players, determinism; value function: five-gameweek horizon, form removed, xG/xA basis (realised returns ignored), minutes security; independent captaincy and vice-from-another-club; comparison covers all four from one snapshot; EVERY changed player explained and each stated reason verified against the data; API and PDF (standard sections + appendix, printed JSON == attached JSON) |
| `scripts/balanced-plus-e2e.mjs` | Browser: page renders 15 players, 4-column comparison (club row `3/3/3/2`), explanations per strategy, PDF downloaded via the button == squad on the page, max 2 per club inside the PDF |
| `report.test.ts` | GW report PDF (see GW_REPORT.md): validity, metadata, text content of all 15 players, printed JSON == attached JSON, JSON completeness, exact on-screen squad (edited squad, My Team plan, Free Hit, Bench Boost), 400/409/422 |
| `scripts/report-e2e.mjs` | **Final E2E (PDF)**: Team Builder (swap a player, download, PDF == on-screen squad incl. the swap, projected points equal the screen, every on-screen name in the PDF text, sections, JSON), My Team (accept a transfer, download, PDF players == proposed squad, actual squad listed unchanged, plan/recommendations/chips present, stored actual untouched), Free Hit (PDF == temporary squad), mobile button visible, no console errors |
| `scripts/season-e2e.mjs` | **Season E2E** in Chrome: import error handling, recommendation shown, accept raises projection while the stored actual squad is byte-identical, restore, replacement panel and swap, undo, Bench Boost (+points, one chip only), Free Hit banner, Wildcard unlimited, plan ahead GW12, lock-in advances actual and stores prediction, typed actual points give error stats, persistence after reload, mobile no horizontal scroll |
| `scripts/screenshots.mjs` | **E2E**: lands on GW11, 15 players on pitch, open player, replace, EP recalculates, restore returns the original EP, strategy + gameweek switch, save, share link → share page, dashboard, player explorer filter + compare, player detail, mobile layout has no horizontal scroll, no console errors |

## Manual verification checklist (done)

- Landing page auto-selects the next gameweek and renders the squad.
- Squad: 2/5/5/3, ≤3 per club, ≤£100m, valid XI, captain ≠ vice.
- Swap a player: legal-only alternatives, EP and bank update, "Restore original squad" returns the original.
- Mobile (390 px) pitch, panel and navigation usable.
