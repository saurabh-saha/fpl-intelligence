# News Intelligence & Player Availability

Additive layer that makes projections, transfers, captaincy, bench order and chip advice aware of real-world availability news. **News only changes the availability/minutes inputs of the existing expected-points model; the xPts formula, the strategy engines and the frozen backtest files are untouched.** With no relevant news every output is byte-identical to before (tested).

## Architecture
```
sources (adapters) -> extract (rules / LLM, validated) -> NewsItem[] -> events (dedupe, supersede, contradict, expire)
   -> availability engine (deterministic) -> overlay -> projections (via the unchanged model) -> strategies / chips / UI
```
| Module | Role |
|---|---|
| `lib/news/sources.ts` | Source adapters + reliability registry; FPL official parser; RSS adapter |
| `lib/news/extract.ts` | Rule-based extractor, LLM extractor (Gemini / DeepSeek / Anthropic), strict validator |
| `lib/news/identity.ts` | Player matching against the FPL dataset (never guesses) |
| `lib/news/events.ts` | Article dedupe, event clustering, supersession, contradiction, expiry |
| `lib/news/availability.ts` | Deterministic adjustment: start probability, minutes, status, reason codes |
| `lib/news/overlay.ts` | Bridge into the model: `newsProject`, `applyNewsToDataset`, `buildOverlay` |
| `lib/news/service.ts` | Refresh orchestration, deadline-aware cadence, rate limit, freshness |
| `lib/news/repository.ts` | Replaceable storage (file cache / memory) |
| `app/api/news`, `app/api/news/refresh`, `app/news` | API + dashboard |

## Sources actually implemented
- **Official FPL status** (`fpl-official`, reliability 0.95): FPL's own news/status fields from `bootstrap-static`; structured and free.
- **BBC Sport Premier League RSS** (`bbc-sport-pl`, 0.70): public feed, headline + summary + link only (no article scraping). BBC offers feeds for non-commercial use; review its terms before any commercial deployment.
- Extra RSS feeds via `NEWS_RSS_FEEDS`.
- **Not implemented** (no reliable, permitted access): premierleague.com / club sites, press-conference transcripts, social media, international squad announcements. International *breaks* are visible from fixture gaps, but who is called up only comes from articles. Nothing is invented where a source is missing.

## Data model
`NewsItem` has the requested fields (playerId, playerName, club, category, severity, headline, summary, sourceName, sourceUrl, publishedAt, retrievedAt, expectedReturnDate, status confirmed|reported|speculative, confidence, affectedGameweeks, evidence) plus `impact` (out | doubt | reduced | fit | none), `representedInFpl`, `needsReview`, `candidates`. `NewsEvent` = one real-world event with all supporting items, distinct sources, belief, contradiction flag.

## Extraction pipeline
1. Fetch -> de-duplicate articles (canonical URL, or >=0.8 headline similarity within 48 h) -> skip already-processed -> pre-filter for availability keywords + a resolvable player name -> cap 12 extractions per refresh.
2. Extractor: **LLM when a server key exists** (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY`; choose with `NEWS_LLM_PROVIDER`), else (or on failure, visibly) the conservative rule-based extractor.
3. **The LLM never supplies ids, urls, timestamps or points.** Its output is validated: the evidence must be a verbatim excerpt of the article; the player must be named in the article; ids come from our own matcher; url/publishedAt come from the article; a return date survives only if the article states that date or a duration; a publisher cannot mark something `confirmed` (only official/club sources can).
4. Ambiguous names (e.g. two players called the same) are kept as `needsReview` with candidates and never reach the projections.

## Deduplication, reliability, contradictions, expiry
- Five articles from one source = one piece of evidence. Belief = 1 − Π(1 − reliability × statusWeight × confidence) over **distinct sources** (confirmed 1, reported 0.6, speculative 0.25).
- Newest trusted item defines the event's present state; older ones stay listed as references.
- A reliable opposing report from another source within 48 h flags a contradiction (effect halved, shown in the UI).
- Expiry by category (injury 28 d, illness 10, suspension 21, training 4, team news 2 ...; speculative halves; a future return date keeps an item alive).

## Availability engine (`availability.ts`)
Deterministic and unit-tested; parameters in `PARAMS` (assumptions, not fitted). Principles: a mention alone does nothing; rumours are weighted not trusted; undated absences fade with a severity time constant (minor 5 d / moderate 18 d / major 60 d); a dated absence is out until the date then eased back in over 14 days; a "doubt" is at most a 50% chance of missing the game; rotation/fatigue/late return trim the **start probability** (cap 35/20/40%) and only for matches soon after; international duty alone changes nothing; **news never stacks on FPL's own status** (the more pessimistic of the two is used, FPL-sourced items only inform later gameweeks via their return date). Outputs: adjustedStartProbability, adjustedExpectedMinutes, availabilityStatus, availabilityConfidence, reasonCodes, supportingNewsIds, plain-English reasons.

## Projection integration
`newsProject` runs the **unchanged** `projectPlayer` with an availability chosen so the model reproduces the adjusted minutes; the projection carries `news` = {baseXpts, newsAdjustedXpts, base/adjusted start probability & minutes, adjustmentReasons, sources}. Consumers:
- **Single-gameweek strategies (Balanced, Safe, Aggressive/Differential, Balanced Plus)**: the frozen code receives a dataset copy (`applyNewsToDataset`) with the adjusted availability for that gameweek (same object returned when no news). Captain/vice and bench order follow automatically.
- **5-GW horizon (transfers, chips, Free Hit, Wildcard, bench order)** and **Season Long**: per-gameweek adjustment (return dates respected).
- **Bench Boost / Triple Captain**: gains use adjusted projections; the advice lists availability risks in the squad and, when news matters, the unadjusted gain for comparison.
- Request body `news:false` (or env `NEWS_DISABLED=1`) switches it off.
Approximation: start-probability cuts are applied through the availability input, so appearance points scale slightly differently from a true start-probability change (documented, small).

## Refresh strategy and caching
Vercel serverless has no background jobs here, so refresh is request-driven: opening `/news`, Team Builder or My Team triggers `GET /api/news?refresh=1`, which refreshes only if the cache is older than the window: **>72 h to deadline 45 min, <=72 h 20, <=24 h 10, <=6 h 5**. Manual "Refresh now" bypasses the window but not a 30 s rate limit. In-flight requests are shared. A failing source is recorded and cached data is kept. The UI says "Up to date" only if the last *successful* refresh is within 1.5 windows, otherwise "Stale"/"Not refreshed yet", always with the timestamp. Strategy routes only *read* the cache (no network, no added latency). A Vercel Cron (daily on Hobby) could be added later as a floor but is not assumed.

## Storage
Server-side file cache (`.cache/news.json`, or the OS temp dir on Vercel) behind the `NewsRepository` interface; no database, nothing in browser storage, keys only in server env (`.env.example` lists names). On Vercel the cache is per instance and ephemeral: after a cold start the first visit rebuilds from the sources (FPL status is instant; articles are re-extracted within the 12-per-refresh cap). Swap `FileNewsRepository` for KV/Postgres when shared persistence is needed.

## Limitations
- Only two sources; no club/press-conference/social/international call-up feeds, so late-return and international items depend on BBC headlines and are rare.
- Rule-based extraction is deliberately conservative (it misses most news); the LLM path is implemented and unit-tested with mocked responses but **was not exercised live** (the supplied Gemini and DeepSeek keys had no credit).
- Engine constants are judgement-based, not backtested; news cannot be backtested fairly (no historical news archive).
- Per-instance cache on serverless; news is not "real time", only as fresh as the last refresh.

## Adding a source
Implement `SourceAdapter` (`meta` + `fetch` returning `articles` for extraction or already-structured `items`), add its reliability to the registry, and register it in `defaultAdapters` (or configure RSS via `NEWS_RSS_FEEDS`). Confirm its terms permit the access first.
