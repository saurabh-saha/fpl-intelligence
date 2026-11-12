# Deployment (GitHub + Vercel)

FPL Intelligence is a standard Next.js 15 app (App Router, route handlers). It needs **no database and no environment variables**.

## Vercel settings

| Setting | Value |
|---|---|
| Framework preset | Next.js (also set in `vercel.json`) |
| Install / build / output | defaults (`npm ci` / `next build` / `.next`) |
| Node.js | 20+ (`engines` in `package.json`) |
| Function duration | 30 s for `app/api/**` (`vercel.json`); the slowest routes (PDF report, season analysis) take 1-3 s |
| Environment variables | none required |

## Serverless adaptations (no strategy logic involved)

- **Files read at runtime** are listed in `outputFileTracingIncludes` in `next.config.ts` so each function bundles what it opens: PDF fonts (`dejavu-fonts-ttf`) and pdfkit's font metrics, the OpenAPI spec, backtest result JSON, and the offline FPL sample (`tests/fixtures`).
- **Writes**: the FPL snapshot cache goes to the OS temp directory when `VERCEL` is set (the project directory is read-only). It is only a best-effort fallback; the 15-minute in-memory cache and the stale-data fallbacks are unchanged.
- **State**: nothing is stored server-side. My Team, saved squads and share links live in the browser or in the URL.
- **Not shipped at runtime**: the backtest (`lib/backtest`, `scripts/`, `data/historical`) only runs locally; it is in the repository but no route imports it.

## Dependence on the FPL API

The app calls `fantasy.premierleague.com/api/*` from the server. FPL is unofficial and may rate-limit or block cloud IP ranges. If it is unreachable the app serves the bundled GW11-era sample snapshot and labels it ("bundled sample", stale). Check the data banner on the Team Builder after deploying; "Data refreshed <time>" without "(bundled sample)" means live data.

## Repository contents worth knowing

- `data/historical/` (4.8 MB) is third-party data with **no declared licence** upstream; keep the repository **private**, or remove those folders and keep only `manifest.json` (see `data/historical/README.md`).
- `docs/samples/` and `docs/screenshots/` are generated artefacts kept for documentation.

## Deploy

```bash
vercel login            # once
vercel link             # connect this folder to a Vercel project
vercel git connect      # connect the GitHub repository (so pushes to main deploy)
vercel deploy --prod
```
