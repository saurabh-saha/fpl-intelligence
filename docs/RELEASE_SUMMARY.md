# Release summary: Balanced Plus, historical validation and cleanup

Status: **ready for review, not committed, not pushed.** (The project folder is not a git repository; see "Review notes".)

## What this release contains

| Area | Change |
|---|---|
| Strategy | Balanced Plus (4th strategy): `lib/strategies/balancedPlus.ts`, `compare.ts`, `report.ts`, `validation.ts`; page `/strategies/balanced-plus`; API `/api/strategies/balanced-plus[/report]`; PDF in the standard report format with a comparison appendix |
| Validation | Rolling five-gameweek backtest of all four strategies on frozen real data: `lib/backtest/*`, `scripts/backtest/*`, `data/historical/*`, `docs/backtest/*`, `docs/BALANCED_PLUS_BACKTEST.md`, audit in `docs/BALANCED_PLUS_AUDIT.md` |
| Report/UI honesty | The objective value the solver maximises is shown beside the displayed xPts; realised-data and form behaviour stated precisely; historical verdict and limitations shown in the UI, the PDF and the docs |
| Cleanup (this pass) | dead code and `void` silencers removed outside the frozen files; shared manifest verification; commit-pinned data fetch with `--check`; shared PDF parser for the E2E scripts; data README with licence warning |

## Conclusion of the validation

**Balanced Plus is competitive, but no advantage over Balanced is established** (held-out 2024-25 and 2025-26, 58 rolling windows: +5.6 points per five-gameweek window, 95% intervals include zero, seasons disagree in sign). Do not describe it as better.

## Verified in this pass

| Check | Result |
|---|---|
| Balanced / Safe / Aggressive unchanged | SHA-256 of every file in `lib/optimizer/` and `lib/analytics/` equals the value recorded before the backtest work; GW11 squads pinned; harness squads equal direct optimiser calls; strategy freeze record verified by the backtest on every run |
| Balanced Plus selection logic and weights | untouched in this pass (`lib/strategies/balancedPlus.ts` hash equals the freeze record) |
| Historical data reproducible | offline: 12/12 files match the manifest; online: a fresh download of the pinned upstream commit is byte-identical for all 12 files; full backtest re-run reproduced every output byte-for-byte (results JSON, windows.csv, gameweeks.csv, comparison table) |
| Objective vs displayed xPts distinguished | UI (note under the pitch + per-player table), PDF appendix, API (`objective`, `strategy.methodology`), docs; asserted by tests |
| Limitations visible | UI card, PDF appendix, `docs/BALANCED_PLUS_BACKTEST.md`, `data/historical/README.md`; test checks each is in the doc |
| Typecheck (also with unused locals/params, non-test code) | clean |
| Unit/integration tests | 224 / 224 |
| Production build | clean |
| Browser E2E (4 suites) | all pass |

## Remaining risks and open items (decisions for you)

1. **No git repository.** There is no diff to review; `git init` + a baseline would be needed. Nothing was committed or pushed anywhere.
2. **Upstream data has no licence** (`NOASSERTION`). `data/historical/` (4.8 MB) is third-party content. Keep this repository private, or ignore `data/historical/*/` and keep only `manifest.json` (data re-creates exactly with `npm run backtest:fetch`; the pinned commit and hashes are enough).
3. **Lint debt deliberately left in the frozen files**: `void` silencers in `lib/optimizer/captainSelector.ts` and `squadOptimizer.ts`, and an unused `raw` ablation option in `balancedPlus.ts`. Removing them would change the hashes that prove the three original strategies are unchanged; clean them in a separate, re-frozen change if wanted.
4. **Statistical power**: only two held-out seasons; cannot detect edges below ~6 points per gameweek. A larger edge claim needs more seasons of data.
5. **Backtest realism**: no point-in-time injury news, final fixture schedule, stale prices, fixed five-gameweek hold (no transfers/chips).
6. **Overlap**: `scripts/backtest.ts` (older live-API backtest feeding the dashboard accuracy card) and `lib/backtest/*` both build point-in-time data from different sources. Intentional (different data), but a candidate to unify later.
7. The Balanced Plus ablation options (`BpOptions`) are exported for the backtest only; the app never sets them.
8. Operational (unchanged): FPL API is unofficial; PDF fonts are read from `node_modules` at runtime; localStorage-only persistence for My Team.

## Review notes

- Files by category: source `lib/` (backtest, strategies, report, season), routes `app/api/`, pages `app/`, components, scripts, tests (13 files, 224 tests), docs, data.
- Run the whole verification: `npx tsc --noEmit && npm test && npx next build`, then with the app running `npm run screenshots; npm run e2e:season; npm run e2e:report; npm run e2e:balanced-plus`.
