/**
 * Rolling historical backtest: Balanced vs Safe vs Aggressive vs Balanced Plus.
 *   npm run backtest:bp                 # full run
 *   QUICK=1 npm run backtest:bp         # one season, for a smoke test
 * Reads only the frozen files in data/historical (see data/historical/manifest.json). Writes docs/backtest/*.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readManifest, verifyHistoricalManifest } from "../../lib/backtest/manifest";
import { freezeOrVerify } from "../../lib/backtest/frozen";
import { loadSeason, type SeasonData } from "../../lib/backtest/historical";
import { BP_VARIANTS, MAIN_STRATEGIES, runSeason, type SkippedWindow, type WindowRecord } from "../../lib/backtest/run";
import { summarise } from "../../lib/backtest/summary";

const OUT = "docs/backtest";
const ROLE = { dev: "development", eval: "evaluation", supp: "supplementary" } as const;
const PLAN = [
  { season: "2023-24", role: ROLE.dev, firstK: 6, note: "Development season: used to verify the harness only. No parameter was chosen from it." },
  { season: "2024-25", role: ROLE.eval, firstK: 6, note: "Held-out evaluation." },
  { season: "2025-26", role: ROLE.eval, firstK: 6, note: "Held-out evaluation (defensive-contribution scoring active)." },
  { season: "2022-23", role: ROLE.supp, firstK: 6, note: "Attempted and EXCLUDED by the data-quality gate: the source has no `starts` for GW1-15 and no xG/xA for GW1-14, so no window has a valid history." },
];

const quick = !!process.env.QUICK;
const log = (...a: unknown[]) => console.log(...a);

function verifyManifest() {
  const v = verifyHistoricalManifest();
  if (v.bad.length) throw new Error(`historical snapshot hash mismatch: ${v.bad.join(", ")}`);
  return readManifest();
}

const pct = (n: number | null | undefined) => (n == null ? "n/a" : n.toFixed(1));
function table(title: string, s: ReturnType<typeof summarise>) {
  log(`\n${title}  (${s.windows} windows)`);
  log("strategy".padEnd(15), "win-pts".padStart(8), "pts/GW".padStart(7), "cap/GW".padStart(7), "projMAE".padStart(8), "bias".padStart(6), "maxClub".padStart(8), "win%".padStart(6), "rank".padStart(5), "  vs Balanced mean [95% CI nonoverlap | block-boot] sign p  evidence");
  for (const st of s.strategies) {
    const w = s.windowResults[st.id];
    const p = s.pairedVsBaseline[st.id];
    log(st.label.slice(0, 14).padEnd(15), String(st.meanWindowPoints).padStart(8), String(st.meanPointsPerGw).padStart(7), String(st.captainPointsPerGw).padStart(7), String(st.projectedVsActual.squadMAEPerGw).padStart(8), String(st.projectedVsActual.biasPerGw).padStart(6), String(st.clubConcentration.meanMaxFromOneClubInXI).padStart(8), pct(w.sharedWinPct).padStart(6), String(w.averageRank).padStart(5), p ? `  ${p.meanDiff} [${p.tCI95NonOverlapping.join(", ")} | ${p.blockBootstrapCI95.join(", ")}] p=${p.signTest.p.toFixed(3)} ${p.evidence}` : "  (baseline)");
  }
}

function csvEscape(v: unknown) { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

async function main() {
  const frozen = freezeOrVerify(!!process.env.FORCE_REFREEZE);
  const manifest = verifyManifest();
  log(`Strategy config frozen at ${frozen.frozenAt} (verified). Historical snapshot upstream commit ${manifest.commit}.`);

  const plan = quick ? PLAN.slice(0, 1) : PLAN;
  const data = new Map<string, SeasonData>();
  const coverage: Record<string, unknown> = {};
  const skipped: SkippedWindow[] = [];
  const firstK: Record<string, number> = {};
  const roleOf: Record<string, string> = {};
  for (const p of plan) {
    const sd = loadSeason(p.season);
    data.set(p.season, sd);
    firstK[p.season] = p.firstK;
    roleOf[p.season] = p.role;
    coverage[p.season] = { role: p.role, note: p.note, players: sd.info.size, gameweeks: sd.maxGw, gameweeksWithFixtures: sd.gwsWithFixtures.size, defensiveContribution: sd.hasDc, firstWindowStart: p.firstK };
  }

  type Run = { windows: WindowRecord[]; skipped: SkippedWindow[] };
  const runs: Record<string, Run> = {};
  const go = (key: string, season: string, strategies: typeof MAIN_STRATEGIES, availability: "recent-minutes" | "none") => {
    const t0 = Date.now();
    const r = runSeason({ sd: data.get(season)!, strategies, availability, firstK: firstK[season] });
    runs[key] = r;
    if (availability === 'recent-minutes' && !key.endsWith('|none')) skipped.push(...r.skipped);
    log(`  ${key}: ${r.windows.length} windows (${r.skipped.length} skipped) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  // Stage A: development season (harness verification only)
  log("\nStage A: development season");
  const devSeason = plan.find((p) => p.role === ROLE.dev)!.season;
  go(`${devSeason}|main`, devSeason, MAIN_STRATEGIES, "recent-minutes");
  const devSummary = summarise(runs[`${devSeason}|main`].windows, MAIN_STRATEGIES, "balanced", firstK);
  table(`DEVELOPMENT ${devSeason} (harness check, not evidence)`, devSummary);

  // Stage B: held-out evaluation with the frozen strategies
  log("\nStage B: held-out evaluation");
  const evalSeasons = plan.filter((p) => p.role === ROLE.eval).map((p) => p.season);
  const ALL = [...MAIN_STRATEGIES, ...BP_VARIANTS];
  for (const s of evalSeasons) go(`${s}|all`, s, ALL, "recent-minutes");
  const evalWindows = evalSeasons.flatMap((s) => runs[`${s}|all`].windows);
  const evalMain = summarise(evalWindows, MAIN_STRATEGIES, "balanced", firstK);
  table("EVALUATION (pooled held-out seasons)", evalMain);
  const perSeason = Object.fromEntries(evalSeasons.map((s) => [s, summarise(runs[`${s}|all`].windows, MAIN_STRATEGIES, "balanced", firstK)]));
  for (const s of evalSeasons) table(`  ${s}`, perSeason[s]);

  // Sensitivity: BP ablations vs Balanced and vs default BP (descriptive)
  const sensAll = summarise(evalWindows, ALL, "balanced", firstK);
  const sensVsBp = summarise(evalWindows, ALL.filter((s) => s.id === "balanced-plus" || s.id.startsWith("bp-")), "balanced-plus", firstK);

  // Stage C: availability-proxy sensitivity (everyone available), main strategies
  log("\nStage C: availability sensitivity");
  for (const s of evalSeasons) go(`${s}|none`, s, MAIN_STRATEGIES, "none");
  const noneSummary = summarise(evalSeasons.flatMap((s) => runs[`${s}|none`].windows), MAIN_STRATEGIES, "balanced", firstK);
  table("EVALUATION with NO availability proxy", noneSummary);

  // Supplementary seasons (flagged)
  const suppSeasons = plan.filter((p) => p.role === ROLE.supp).map((p) => p.season);
  for (const s of suppSeasons) go(`${s}|main`, s, MAIN_STRATEGIES, "recent-minutes");
  const supp: Record<string, ReturnType<typeof summarise> | { excluded: string }> = {};
  for (const s of suppSeasons) {
    const w = runs[`${s}|main`].windows;
    if (w.length === 0) { supp[s] = { excluded: [...new Set(runs[`${s}|main`].skipped.map((x) => x.reason))].join(' | ') }; log(`\nSUPPLEMENTARY ${s}: excluded by gate: ${(supp[s] as any).excluded}`); }
    else { supp[s] = summarise(w, MAIN_STRATEGIES, 'balanced', firstK); table(`SUPPLEMENTARY ${s}`, supp[s] as ReturnType<typeof summarise>); }
  }

  // Everything pooled (for completeness)
  const pooledAllWindows = [...runs[`${devSeason}|main`].windows, ...evalWindows, ...suppSeasons.flatMap((s) => runs[`${s}|main`].windows)];
  const pooledAll = summarise(pooledAllWindows, MAIN_STRATEGIES, "balanced", firstK);

  // ---- write outputs ----
  mkdirSync(OUT, { recursive: true });
  const assumptions = [
    "Squads are chosen at deadline k from rows with round < k only; lineups at each later gameweek use rows with round < that gameweek.",
    "Prices are the previous gameweek's price (up to ~7 days stale); the £100m budget and 3-per-club limit apply to every strategy.",
    "Injury/suspension/availability news has no point-in-time source and is NOT used. A proxy from past minutes only (0 minutes in each of a club's last two matches => doubtful) is applied equally to all strategies; Stage C removes it.",
    "The fixture list is the FINAL season schedule, so fixtures rearranged after an earlier deadline appear in their final gameweek. FDR is not used.",
    "A player with no row before the deadline is unknown at that deadline (new signings are invisible until they have a row).",
    "Strategies hold one squad for five gameweeks (no transfers, chips, or price changes) and re-pick XI/bench/captain at each gameweek with their own lineup rule. FPL auto-substitutions and the vice-captain rule are applied.",
    "Ownership % is derived as selected / (sum of selected / 15) of the previous gameweek.",
    "`form` is derived as the mean points of the last three appearances.",
    "Source data is a third-party scrape (vaastav/Fantasy-Premier-League); completeness and accuracy are assumed, not verified against FPL.",
    "Windows containing a gameweek with no recorded fixtures are skipped.",
    "Parameters were NOT tuned on any window. The sensitivity runs are descriptive.",
  ];
  const result = {
    generatedAt: new Date().toISOString(),
    frozen: { at: frozen.frozenAt, sourceHashes: frozen.config.sourceHashes, balancedPlusParameters: frozen.config.balancedPlusParameters, horizonWeights: frozen.config.horizonWeights },
    data: { source: manifest.source, upstreamCommit: manifest.commit, fetchedAt: manifest.fetchedAt, files: manifest.files.map((f: any) => ({ season: f.season, file: f.file, sha256: f.sha256 })) },
    design: { windowLengthGameweeks: 5, strategies: MAIN_STRATEGIES.map((s) => s.id), baseline: "balanced", unit: "five-gameweek window with a fixed squad", firstWindowStart: firstK, roles: roleOf },
    coverage,
    skippedWindows: skipped,
    assumptions,
    development: devSummary,
    evaluation: { pooled: evalMain, perSeason },
    sensitivity: {
      note: "Ablations of Balanced Plus on the held-out seasons. Descriptive only: nothing was selected from this table.",
      variants: ALL.map((s) => ({ id: s.id, label: s.label })),
      vsBalanced: sensAll,
      vsBalancedPlus: sensVsBp,
      availabilityProxyOff: noneSummary,
    },
    supplementary: supp,
    allSeasonsPooled: pooledAll,
  };
  writeFileSync(path.join(OUT, "balanced-plus-backtest-results.json"), JSON.stringify(result, null, 1));

  const wCsv = ["season,role,k,rotation_index,strategy,window_points,captain_points,projected_points,cost_m,squad_ids"];
  const gCsv = ["season,window_start,gw,strategy,formation,projected,actual,captain_points,captain_did_not_play,captain_rank_in_xi,auto_subs,bench_used_points,bench_unused_points,max_from_one_club,xi_avg_minutes,xi_dnp,xi_under60,lineup_relaxed"];
  const allRuns = Object.entries(runs).filter(([k]) => !k.endsWith("|none"));
  for (const [, r] of allRuns) for (const w of r.windows) for (const [id, st] of Object.entries(w.strategies)) {
    wCsv.push([w.season, roleOf[w.season], w.k, Number.isFinite(w.rotation) ? w.rotation.toFixed(4) : "", id, st.points, st.captainPoints, st.projected.toFixed(2), (st.costTenths / 10).toFixed(1), `"${st.squad.join(" ")}"`].map(csvEscape).join(","));
    for (const g of st.gws) gCsv.push([w.season, w.k, g.gw, id, g.formation, g.proj.toFixed(2), g.actual, g.captainPoints, g.captainDidNotPlay ? 1 : 0, g.captainRank, g.autoSubs, g.benchUsedPoints, g.benchUnusedPoints, g.maxClubXI, g.xiMinutesAvg.toFixed(1), g.xiDnp, g.xiUnder60, g.relaxed].map(csvEscape).join(","));
  }
  writeFileSync(path.join(OUT, "windows.csv"), wCsv.join("\n") + "\n");
  writeFileSync(path.join(OUT, "gameweeks.csv"), gCsv.join("\n") + "\n");

  // compact comparison table for the report
  const cmp = evalMain.strategies.map((s) => ({ id: s.id, label: s.label, meanWindowPoints: s.meanWindowPoints, pointsPerGw: s.meanPointsPerGw, captainPerGw: s.captainPointsPerGw, squadMAEPerGw: s.projectedVsActual.squadMAEPerGw, biasPerGw: s.projectedVsActual.biasPerGw, meanMaxClubInXI: s.clubConcentration.meanMaxFromOneClubInXI, sharedWinPct: evalMain.windowResults[s.id].sharedWinPct, averageRank: evalMain.windowResults[s.id].averageRank, vsBalanced: evalMain.pairedVsBaseline[s.id] ?? null }));
  writeFileSync(path.join(OUT, "comparison-table.json"), JSON.stringify(cmp, null, 1));
  log(`\nwrote ${OUT}/balanced-plus-backtest-results.json, windows.csv (${wCsv.length - 1} rows), gameweeks.csv (${gCsv.length - 1} rows), comparison-table.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
