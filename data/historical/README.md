# Frozen historical FPL data

Used only by the rolling backtest (`npm run backtest:bp`). **Real data, nothing synthesised.**

| | |
|---|---|
| Source | https://github.com/vaastav/Fantasy-Premier-League (per-gameweek player rows scraped from the official FPL API, plus fixtures and teams) |
| Pinned upstream commit | recorded in `manifest.json` (`commit`, `commitDate`) |
| Seasons | 2022-23, 2023-24, 2024-25, 2025-26 |
| Files per season | `merged_gw.csv.gz` (player x gameweek rows), `fixtures.csv.gz`, `teams.csv.gz` (gzip of the unmodified upstream CSV) |
| Integrity | `manifest.json` holds the SHA-256 of every **uncompressed** file; the backtest verifies them on every run |

## Verify and reproduce

```bash
npm run backtest:verify-data   # offline: re-hash the stored files against the manifest
npm run backtest:fetch -- --check   # online: download the PINNED commit and compare hashes (writes nothing)
npm run backtest:fetch              # re-download the pinned commit (hash-verified)
npm run backtest:fetch -- --refresh # DELIBERATELY move to current upstream master: new commit, new hashes, results will change
```

Fetches are pinned to the commit in the manifest, never to `master`, so the same bytes come back.

## Columns used

`element, name, position, team, fixture, GW, minutes, starts, goals_scored, assists, expected_goals, expected_assists, expected_goals_conceded, clean_sheets, goals_conceded, saves, bonus, bps, yellow_cards, red_cards, total_points, value, selected` and, from 2025-26, `defensive_contribution`. From `fixtures.csv`: `id, event, finished, kickoff_time, team_h, team_a, team_h_score, team_a_score, team_h_difficulty, team_a_difficulty` (FDR is read but never used by any strategy). From `teams.csv`: `id, code, name, short_name`.

## Known data issues

- **2022-23**: no `starts` for GW1-15 and no `expected_*` for GW1-14, and GW7 is absent. The backtest's data-quality gate rejects every 2022-23 window; the season is kept only as evidence of that exclusion.
- No point-in-time injury/availability news exists in the source (FPL overwrites it in place).
- Fixtures carry the **final** schedule; prices are the previous gameweek's (up to ~7 days stale).
- Third-party scrape: completeness and accuracy are assumed, not verified against FPL.

## Licence (read before publishing this repository)

The upstream repository **declares no licence** (GitHub reports `NOASSERTION`). The files are kept here for private, reproducible research. **Do not publish or redistribute them without checking with the upstream author.** If this project is made public, add `data/historical/*/` to `.gitignore` and keep only `manifest.json` (the hashes and the pinned commit are enough to re-create the data with `npm run backtest:fetch`).
