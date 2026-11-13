/**
 * Backtest of the Season Long strategy against Balanced, Safe, Aggressive (Differential) and Balanced Plus,
 * using the SAME point-in-time harness, frozen real data and evaluation rules as the Balanced Plus backtest.
 *   npx tsx scripts/backtest/run-season-long-backtest.ts       (about 10 minutes)
 *
 * Design: at deadline k each strategy builds a legal 15-man squad from information available before k and HOLDS it for L gameweeks
 * (L = 5 and L = 10), re-picking XI and captain every gameweek with its own lineup rule. Season Long's squad is optimised for the
 * whole remaining season (k..GW38), so a fixed hold of 5 or 10 gameweeks tests only a slice of its horizon and gives it no chance
 * to use its transfers: see docs/SEASON_LONG.md for what this can and cannot show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { freezeOrVerifySeasonLong } from "../../lib/backtest/frozen";
import { loadSeason, type SeasonData } from "../../lib/backtest/historical";
import { readManifest, verifyHistoricalManifest } from "../../lib/backtest/manifest";
import { MAIN_STRATEGIES, runSeason, type StrategyDef, type WindowRecord } from "../../lib/backtest/run";
import { summarise } from "../../lib/backtest/summary";

const OUT = "docs/backtest";
const SL: StrategyDef = { id: "season-long", label: "Season Long", kind: "sl" };
const MAIN: StrategyDef[] = [...MAIN_STRATEGIES, SL];
/** Descriptive sensitivity of Season Long (never used to choose parameters). */
const SL_VARIANTS: StrategyDef[] = [
  { id: "sl-no-discount", label: "SL no time-discount (delta 1.0)", kind: "sl", sl: { params: { discount: 1 } } },
  { id: "sl-discount-0.85", label: "SL steeper discount (0.85)", kind: "sl", sl: { params: { discount: 0.85 } } },
  { id: "sl-horizon-5", label: "SL with a 5-gameweek horizon", kind: "sl", sl: { horizon: 5 } },
  { id: "sl-horizon-10", label: "SL with a 10-gameweek horizon", kind: "sl", sl: { horizon: 10 } },
  { id: "sl-no-absence-haircut", label: "SL without the future-absence haircut", kind: "sl", sl: { params: { futureAbsence: 0 } } },
  { id: "sl-fixture-blend-0.96", label: "SL blending distant fixtures (rho 0.96)", kind: "sl", sl: { params: { fixtureTrust: 0.96 } } },
];
const PLAN = [
  { season: "2023-24", role: "development", firstK: 6 },
  { season: "2024-25", role: "evaluation", firstK: 6 },
  { season: "2025-26", role: "evaluation", firstK: 6 },
];
const csvEscape = (v: unknown) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const log = (...a: unknown[]) => console.log(...a);
const sg = (n: number | null | undefined) => (n == null ? "n/a" : (n > 0 ? "+" : "") + n.toFixed(1));

function table(title: string, s: ReturnType<typeof summarise>, baseline: string) {
  log(`\n${title} (${s.windows} windows, paired vs ${baseline})`);
  log("strategy".padEnd(34), "win-pts".padStart(8), "pts/GW".padStart(7), "win%".padStart(6), "rank".padStart(5), "  diff [95% CI nonoverlap | block-boot] sign p  evidence");
  for (const st of s.strategies) {
    const p = s.pairedVsBaseline[st.id];
    log(st.label.slice(0, 33).padEnd(34), String(st.meanWindowPoints).padStart(8), String(st.meanPointsPerGw).padStart(7), String(s.windowResults[st.id].sharedWinPct).padStart(6), String(s.windowResults[st.id].averageRank).padStart(5), p ? `  ${sg(p.meanDiff)} [${p.tCI95NonOverlapping.map(sg).join(", ")} | ${p.blockBootstrapCI95.map(sg).join(", ")}] p=${p.signTest.p.toFixed(3)} ${p.evidence}` : "  (baseline)");
  }
}

async function main() {
  const frozen = freezeOrVerifySeasonLong(!!process.env.FORCE_REFREEZE);
  const v = verifyHistoricalManifest();
  if (v.bad.length) throw new Error(`historical snapshot hash mismatch: ${v.bad.join(", ")}`);
  const manifest = readManifest();
  log(`Season Long freeze ${frozen.frozenAt} (verified); ${v.checked} data files match upstream commit ${manifest.commit}`);

  const data = new Map<string, SeasonData>(PLAN.map((p) => [p.season, loadSeason(p.season)]));
  const firstK = Object.fromEntries(PLAN.map((p) => [p.season, p.firstK]));
  const runs: Record<string, WindowRecord[]> = {};
  const go = (key: string, season: string, strategies: StrategyDef[], L: number) => {
    const t0 = Date.now();
    runs[key] = runSeason({ sd: data.get(season)!, strategies, availability: "recent-minutes", firstK: firstK[season], windowLength: L }).windows;
    log(`  ${key}: ${runs[key].length} windows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  };
  const evalSeasons = PLAN.filter((p) => p.role === "evaluation").map((p) => p.season);

  const result: Record<string, unknown> = {};
  const csvW = ["window_length,season,role,k,strategy,window_points,captain_points,projected_points,cost_m"];
  const csvG = ["window_length,season,window_start,gw,strategy,formation,projected,actual,captain_points,max_from_one_club,xi_dnp"];
  const dump = (L: number, season: string, role: string, ws: WindowRecord[]) => {
    for (const w of ws) for (const [id, st] of Object.entries(w.strategies)) {
      csvW.push([L, season, role, w.k, id, st.points, st.captainPoints, st.projected.toFixed(2), (st.costTenths / 10).toFixed(1)].map(csvEscape).join(","));
      for (const g of st.gws) csvG.push([L, season, w.k, g.gw, id, g.formation, g.proj.toFixed(2), g.actual, g.captainPoints, g.maxClubXI, g.xiDnp].join(","));
    }
  };

  for (const L of [5, 10]) {
    log(`\n===== windows of ${L} gameweeks =====`);
    const dev = PLAN.find((p) => p.role === "development")!.season;
    go(`${dev}|L${L}|main`, dev, MAIN, L);
    const devS = summarise(runs[`${dev}|L${L}|main`], MAIN, "balanced", firstK, L);
    table(`DEVELOPMENT ${dev} L=${L} (harness check, not evidence)`, devS, "balanced");
    dump(L, dev, "development", runs[`${dev}|L${L}|main`]);

    for (const s of evalSeasons) go(`${s}|L${L}|all`, s, L === 5 ? [...MAIN, ...SL_VARIANTS] : MAIN, L);
    const ws = evalSeasons.flatMap((s) => runs[`${s}|L${L}|all`]);
    evalSeasons.forEach((s) => dump(L, s, "evaluation", runs[`${s}|L${L}|all`]));
    const pooled = summarise(ws, MAIN, "balanced", firstK, L);
    const vsBp = summarise(ws, MAIN, "balanced-plus", firstK, L);
    table(`EVALUATION pooled L=${L}`, pooled, "balanced");
    table(`EVALUATION pooled L=${L}`, vsBp, "balanced-plus");
    const perSeason = Object.fromEntries(evalSeasons.map((s) => [s, summarise(runs[`${s}|L${L}|all`], MAIN, "balanced", firstK, L)]));
    for (const s of evalSeasons) table(`  ${s} L=${L}`, perSeason[s], "balanced");
    const entry: Record<string, unknown> = { development: devS, evaluation: { pooledVsBalanced: pooled, pooledVsBalancedPlus: vsBp, perSeason } };
    if (L === 5) {
      const all = [...MAIN, ...SL_VARIANTS];
      entry.sensitivity = {
        note: "Ablations of Season Long on the held-out seasons. Descriptive only: nothing was selected from this table.",
        variants: SL_VARIANTS.map((s) => ({ id: s.id, label: s.label })),
        vsBalanced: summarise(ws, all, "balanced", firstK, L),
        vsSeasonLong: summarise(ws, all.filter((s) => s.id === "season-long" || s.id.startsWith("sl-")), "season-long", firstK, L),
      };
      table("SENSITIVITY vs Season Long (L=5)", (entry.sensitivity as { vsSeasonLong: ReturnType<typeof summarise> }).vsSeasonLong, "season-long");
    }
    result[`L${L}`] = entry;
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/season-long-backtest-results.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    frozen: { at: frozen.frozenAt, ...frozen.config },
    data: { source: manifest.source, upstreamCommit: manifest.commit, files: manifest.files.map((f) => ({ season: f.season, file: f.file, sha256: f.sha256 })) },
    design: { strategies: MAIN.map((s) => s.id), windowLengths: [5, 10], baselines: ["balanced", "balanced-plus"], roles: Object.fromEntries(PLAN.map((p) => [p.season, p.role])), firstWindowStart: firstK, calibration: "docs/backtest/season-long-calibration.json (development season only)" },
    ...result,
  }, null, 1));
  writeFileSync(`${OUT}/season-long-windows.csv`, csvW.join("\n") + "\n");
  writeFileSync(`${OUT}/season-long-gameweeks.csv`, csvG.join("\n") + "\n");
  log(`\nwrote ${OUT}/season-long-backtest-results.json, season-long-windows.csv (${csvW.length - 1} rows), season-long-gameweeks.csv (${csvG.length - 1} rows)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
