# Architecture

```
Browser (Next.js app router, React, Tailwind)
   │  fetch
   ▼
Next.js route handlers  app/api/*        ← thin: parse/validate input, call libs, shape JSON
   │
   ├─ lib/fpl        client (fetch + 15-min cache + fallbacks) · normalizer · types
   ├─ lib/analytics  fixtureAnalysis · expectedPoints · playerScoring (modes + explanations) · consistency
   └─ lib/optimizer  squadOptimizer (ILP) · formationOptimizer · captainSelector · alternatives · validation
```

The engines (`lib/*`) have **no UI or Next.js dependency** and are unit-tested in isolation. The UI never sees the raw FPL payload, only normalised types.

## Data flow (select gameweek → squad)

1. `getDataset()` returns a normalised `Dataset` (players, teams, events, fixtures, scoring, rules). Cached for 15 min, concurrent requests de-duplicated.
2. `projectAll(ds, gw, prefs)` computes a `Projection` per player: `ep` (expected points), `score` (mode-adjusted value), confidence, start probability, fixtures, component breakdown, reasons, warnings.
3. `optimizeSquad` solves the ILP on a pruned candidate pool, validates the result, then `bestLineup` derives formation/XI/bench/captain.
4. `squadView` shapes players + projections for the UI.

## Caching and resilience (`lib/fpl/client.ts`)

| Situation | Behaviour |
|---|---|
| Fresh (<15 min) | Serve memory cache |
| Expired | Re-fetch bootstrap + fixtures in parallel; one in-flight request shared |
| Fetch fails / body is "being updated" text | Serve previous in-memory data flagged `stale` |
| Cold start + API down | Last good disk snapshot (`.cache/snapshot.json`), flagged `stale` |
| No snapshot either | Bundled sample (`tests/fixtures`), `source: "sample"` |

Every data response carries `fetchedAt`, `source`, `stale`; the UI shows the last refresh time and a warning banner when stale. Per-player history (`element-summary`) is cached separately.

## Data model (`lib/fpl/types.ts`)

- `Player`: ids, position (`GKP|DEF|MID|FWD`), price as **integer tenths** (`costTenths`, avoids float error), season totals, per-90 rates, ownership, availability (`status`, `chanceNext`, `news`), set-piece orders, photo URL.
- `Team`: derived `played/goalsFor/goalsAgainst` (from finished fixtures) and `xGFor/xGAgainst` (from player aggregates), because the API's team strength fields are zeroed.
- `Rules` and `Scoring` are read from the API (`game_settings`/`game_config`), defaults only if absent.
- `Projection`, `Lineup`, `SquadResult` are the analytics/optimiser outputs.

## Optimiser

Maximise, over binary `x_i` (in squad) and `s_i` (in XI):

```
Σ s_i·score_i·(1−λ) + Σ x_i·score_i·λ      λ = 0.12 (bench is worth a fraction of a starter)
s.t.  s_i ≤ x_i
      Σ x_i = 15;  Σ x_i[pos] = quota(pos)      (2/5/5/3)
      Σ s_i = 11;  Σ s_i[GKP] = 1;  minPlay ≤ Σ s_i[pos] ≤ maxPlay
      Σ x_i·cost_i ≤ budget
      Σ x_i[club] ≤ 3  for every club
      (optional) Σ s_i[pos] = chosen formation
```

- Solved with `javascript-lp-solver` (pure JS, branch-and-cut) on a pruned pool (top by score, best value-for-money, cheapest enablers, best per price point), typically **<150 ms**.
- Tiny deterministic tie-breakers (cheaper, then lower id) make output reproducible.
- After solving, the squad is **independently re-validated** (`validateSquad`). If the solver ever failed or produced something illegal, a budget-reserving greedy fallback runs, and if that also fails the API returns `422` with a clear message. **An invalid squad is never returned.**
- Captain = highest `ep` in the XI; vice = best remaining *reliable* starter (start prob ≥ 0.8, availability ≥ 0.9). Bench: substitute keeper first, then outfield by value.
- Replacement (`findAlternatives`): same position, not owned, status not unavailable, resulting squad passes `validateSquad` (budget + club limit); each candidate gets the true Δ squad points from re-running `bestLineup` on the swapped squad.

## API surface

See [openapi.yaml](openapi.yaml). Summary:

| Route | Purpose |
|---|---|
| `GET /api/bootstrap` | gameweeks, teams, rules, scoring, current/next GW, freshness |
| `GET /api/fixtures?event=` · `GET /api/gameweek/{id}` | fixtures with FDR; deadline; blank teams |
| `GET /api/players` | searchable/sortable projections |
| `GET /api/player/{id}` | profile + history + consistency + next 6 GWs |
| `POST /api/optimize` | generate squad |
| `POST /api/evaluate` | validate + recalc an edited squad |
| `POST /api/alternatives` | legal replacements with Δ points |
| `GET /api/share-image?d=` | PNG of a shared squad |
| `GET /api/backtest` · `GET /api/openapi` | backtest summary · spec |

Errors are `{ "error": string }` with `400` (bad input), `404`, `422` (infeasible / illegal squad), `500`.

## Sharing without accounts

A squad is `[gw, 15 ids (XI then bench), captain, vice, name, mode]`, JSON → base64url in `?d=`. The share page and image route decode it, re-validate, and recompute projections from current data, so links are stateless and tamper-safe (an illegal payload is rejected). Saved squads live in `localStorage`. The structure is ready for accounts later (swap storage + add `id`-based share routes).

## Project layout

```
app/            pages (dashboard, team-builder, players, player/[id], share) and api/*
components/     GameweekSelector, FootballPitch, PlayerCard, AlternativeSelector (PlayerPanel),
                BudgetSummary, ControlsPanel, ShareModal, PlayerComparison, FixtureDifficulty, Countdown, Photo, Nav
lib/fpl/        client, normalizer, types
lib/analytics/  fixtureAnalysis, expectedPoints, playerScoring, consistency
lib/optimizer/  squadOptimizer, formationOptimizer, captainSelector, alternatives, validation
lib/            api.ts (route helpers/view models), client.ts (browser helpers, saved squads), share.ts
scripts/        backtest.ts, screenshots.mjs (E2E), document-schema.ts
tests/          Vitest suites + real FPL snapshot (tests/fixtures)
docs/           this documentation, OpenAPI, schema, screenshots, backtest results
```
