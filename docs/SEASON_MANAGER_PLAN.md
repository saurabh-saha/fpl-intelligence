# Season Manager: implementation plan (incremental update)

## What exists and is reused unchanged
| Need | Existing module |
|---|---|
| Player/team/fixture data, 15-min cache, fallbacks | `lib/fpl/client.ts`, `normalizer.ts` (extended, not replaced) |
| Expected points per player per GW, explanations | `lib/analytics/*` (`projectAll`, `projectPlayer`) |
| Squad rules, XI/formation/captain, ILP optimiser | `lib/optimizer/*` (`validateSquad`, `bestLineup`, `optimizeSquad`, `findAlternatives`) |
| Pitch, player panel, share modal/page/image, FDR badges | `components/*`, `/share`, `/api/share-image` |
| GW selection | `GameweekSelector` + `nextGameweek()` (lands on next GW) |
| Persistence | `localStorage` only (saved squads). Extended with a versioned season store |
| FPL endpoints already used | `bootstrap-static`, `fixtures`, `element-summary`, `event/{gw}/live` |

## Verified rules (2026/27) and where each comes from
| Rule | Value | Source of truth |
|---|---|---|
| Free transfers | 1 per GW, max **5** banked | Premier League 2026/27 changes article; API `game_config.rules.max_extra_free_transfers=4` (1+4) |
| Extra transfer cost | **-4** points each | Official FPL rules (API has no field; constant) |
| Selling price | buy + floor(profit x 0.5), losses in full | API `transfers_sell_on_fee=0.5`, `element_sell_at_purchase_price=false` |
| Budget / club limit / squad | £100m, 3 per club, 15 players | API `game_config.rules` |
| Chips | 2 sets of Wildcard, Free Hit, Bench Boost, Triple Captain. Set 1 usable GW1/2-19, set 2 GW20-38; unused set-1 chips are lost; one chip per GW; Free Hit not in GW1 and not in the GW after a Free Hit | API `chips[]` windows; PL "What's happening with FPL chips in 2026/27" |
| Banked FTs and chips | Wildcard/Free Hit **keep** banked free transfers (no new one accrued that week) | Relayed secondhand (Fantasy Football Scout quoting FPL site); the PL articles are silent. Implemented as a documented policy and flagged |
| AFCON top-up | none in 2026/27 | PL changes article |

## New modules
`lib/season/` (pure, no UI): `types`, `rules` (selling price, FT roll-forward, chip legality), `squad` (apply plan, roll forward, edit plan), `horizon` (5-GW projections), `transfers` (beam-search optimiser + save-vs-use), `chips` (strategy), `importer` (entry reconstruction, FT simulation), `store` (browser persistence).
API (stateless; client sends season state): `/api/season/{evaluate,transfers,chips,alternatives,freehit,wildcard}`, `/api/import/{teamId}`.
UI: `/my-team` (+ nav item), reusing `FootballPitch`, `PlayerPanel` (generalised with an optional loader), `ShareModal`.

## Phases
1 season state + persistence (actual / proposed / Free Hit never overwrite each other) - 2 free transfers + recommendations - 3 replacement + optimiser - 4 chips - 5 import - 6 history, predicted vs actual, sharing.
