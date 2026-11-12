/** Generates docs/BALANCED_PLUS_BACKTEST.md from docs/backtest/balanced-plus-backtest-results.json (tables are never hand-typed). */
import { readFileSync, writeFileSync } from "node:fs";
import { loadValidationSummary } from "../../lib/strategies/validation";
import { t975 } from "../../lib/backtest/stats";

const r = JSON.parse(readFileSync("docs/backtest/balanced-plus-backtest-results.json", "utf8"));
const ev = r.evaluation.pooled;
const f = (n: number | null | undefined, d = 1) => (n == null ? "n/a" : (n >= 0 && d >= 0 ? "" : "") + n.toFixed(d));
const sg = (n: number | null | undefined, d = 1) => (n == null ? "n/a" : (n > 0 ? "+" : "") + n.toFixed(d));
const ci = (a: [number, number]) => `[${sg(a[0])}, ${sg(a[1])}]`;
const md = (rows: string[][]) => `| ${rows[0].join(" | ")} |\n|${rows[0].map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|\n${rows.slice(1).map((x) => `| ${x.join(" | ")} |`).join("\n")}`;
const val = loadValidationSummary();

function strategyTable(s: any, title?: string) {
  const rows = [["Strategy", "Mean pts / 5-GW window", "Pts / GW", "Captain pts / GW", "Squad MAE / GW", "Bias (proj-actual) / GW", "Mean max from one club in XI", "Window wins %", "Avg rank (1-4)", "Mean diff vs Balanced"]];
  for (const x of s.strategies) {
    const p = s.pairedVsBaseline[x.id];
    rows.push([x.label, f(x.meanWindowPoints), f(x.meanPointsPerGw), f(x.captainPointsPerGw), f(x.projectedVsActual.squadMAEPerGw), sg(x.projectedVsActual.biasPerGw), f(x.clubConcentration.meanMaxFromOneClubInXI, 2), f(s.windowResults[x.id].sharedWinPct), f(s.windowResults[x.id].averageRank, 2), p ? sg(p.meanDiff) : "baseline"]);
  }
  return (title ? `**${title}** (${s.windows} windows)\n\n` : "") + md(rows);
}

function pairedTable(entries: [string, any][]) {
  const rows = [["Sample (BP minus Balanced)", "Windows (non-overl.)", "Mean", "Median", "SD", "Variance", "95% CI, t (non-overl.)", "95% CI, block bootstrap (all)", "Sign test p (non-overl.)", "Effect size", "Evidence"]];
  for (const [name, p] of entries) rows.push([name, `${p.nWindows} (${p.nNonOverlapping})`, sg(p.meanDiff), sg(p.medianDiff), f(p.sdDiff), f(p.varianceDiff, 0), ci(p.tCI95NonOverlapping), ci(p.blockBootstrapCI95), f(p.signTest.p, 3), f(p.effectSize, 2), p.evidence]);
  return md(rows);
}
const bp = (s: any) => s.pairedVsBaseline["balanced-plus"];

function detail(s: any) {
  const rows = [["Metric", ...s.strategies.map((x: any) => x.label)]];
  const line = (name: string, g: (x: any) => string) => rows.push([name, ...s.strategies.map(g)]);
  line("Starting-XI points / GW (before captain)", (x) => f(x.xiPointsPerGw));
  line("Captain points / GW (counted once)", (x) => f(x.captain.meanPoints, 2));
  line("Captain blank rate (<= 2 pts)", (x) => `${f(100 * x.captain.blankRate)}%`);
  line("Captain haul rate (>= 10 pts)", (x) => `${f(100 * x.captain.haulRate)}%`);
  line("Captain did not play", (x) => `${f(100 * x.captain.didNotPlayRate)}%`);
  line("Captain rank within the XI (1 = best)", (x) => f(x.captain.meanRankInXI, 2));
  line("Captain regret vs best XI player (pts)", (x) => f(x.captain.meanRegretVsBestInXI, 2));
  line("Projected pts / GW (model, at each deadline)", (x) => f(x.projectedVsActual.meanProjectedPerGw));
  line("Actual pts / GW", (x) => f(x.projectedVsActual.meanActualPerGw));
  line("Squad-level MAE / GW", (x) => f(x.projectedVsActual.squadMAEPerGw));
  line("Five-gameweek window MAE", (x) => f(x.projectedVsActual.windowMAE));
  line("Per-starter MAE (pts)", (x) => f(x.projectedVsActual.playerMAE, 2));
  line("Per-starter bias (proj-actual)", (x) => sg(x.projectedVsActual.playerBias, 2));
  line("Minutes per starter", (x) => f(x.startingXI.meanMinutesPerStarter));
  line("Starters who did not play", (x) => `${f(100 * x.startingXI.didNotPlayRate)}%`);
  line("Starters under 60 minutes", (x) => `${f(100 * x.startingXI.under60Rate)}%`);
  line("Auto-substitutions / GW", (x) => f(x.startingXI.autoSubsPerGw, 2));
  line("Points added by auto-subs / GW", (x) => f(x.bench.pointsAddedByAutoSubsPerGw, 2));
  line("Unused bench points / GW", (x) => f(x.bench.unusedBenchPointsPerGw, 2));
  line("GWs with 3+ players from one club in XI", (x) => `${f(100 * x.clubConcentration.shareOfGwsWith3Plus)}%`);
  line("Lineup rule had to relax a Balanced Plus bar", (x) => `${f(100 * x.lineupRelaxedShare)}%`);
  return md(rows);
}

function formationTable(s: any) {
  const all = [...new Set(s.strategies.flatMap((x: any) => Object.keys(x.byFormation)))].sort() as string[];
  const rows = [["Formation", ...s.strategies.map((x: any) => `${x.label}: GWs / mean pts`)]];
  for (const fm of all) rows.push([fm, ...s.strategies.map((x: any) => (x.byFormation[fm] ? `${x.byFormation[fm].gameweeks} / ${f(x.byFormation[fm].meanPoints)}` : "-"))]);
  return md(rows);
}

function sens() {
  const a = r.sensitivity.vsBalanced;
  const b = r.sensitivity.vsBalancedPlus;
  const rows = [["Variant", "Mean pts / window", "Diff vs Balanced [block-bootstrap 95% CI]", "Diff vs default Balanced Plus [block-bootstrap 95% CI]"]];
  for (const s of a.strategies) {
    const pa = a.pairedVsBaseline[s.id];
    const pb = b.pairedVsBaseline[s.id];
    rows.push([s.label, f(s.meanWindowPoints), pa ? `${sg(pa.meanDiff)} ${ci(pa.blockBootstrapCI95)}` : "baseline", pb ? `${sg(pb.meanDiff)} ${ci(pb.blockBootstrapCI95)}` : s.id === "balanced-plus" ? "reference" : "n/a"]);
  }
  return md(rows);
}

function rotation(s: any) {
  const rows = [["Strategy", "High-rotation windows: mean pts (diff vs Balanced)", "Low-rotation windows: mean pts (diff vs Balanced)"]];
  for (const x of s.strategies) rows.push([x.label, `${f(s.rotation.high[x.id].meanWindowPoints)} (${sg(s.rotation.high[x.id].diffVsBaseline)})`, `${f(s.rotation.low[x.id].meanWindowPoints)} (${sg(s.rotation.low[x.id].diffVsBaseline)})`]);
  return md(rows);
}

const p = bp(ev);
const hw = (p.tCI95NonOverlapping[1] - p.tCI95NonOverlapping[0]) / 2;
const se = hw / t975(p.nNonOverlapping - 1);
const mde = 2.8 * se;
const needed = Math.ceil(((2.8 * p.sdDiff) / 10) ** 2);
const perSeason = Object.entries(r.evaluation.perSeason).map(([s, v]: [string, any]) => `${s}: ${sg(bp(v).meanDiff)}`).join(", ");
const none = bp(r.sensitivity.availabilityProxyOff);
const dev = bp(r.development);

const doc = `# Balanced Plus: rolling historical backtest

> Generated by \`scripts/backtest/make-backtest-doc.ts\` from \`docs/backtest/balanced-plus-backtest-results.json\`. Re-run \`npm run backtest:bp\` then \`npx tsx scripts/backtest/make-backtest-doc.ts\` to reproduce. Audit that preceded this work: [BALANCED_PLUS_AUDIT.md](BALANCED_PLUS_AUDIT.md).

## Recommendation

**${val.verdictText}**

${val.lines!.map((l) => `- ${l}`).join("\n")}

Why, in short:

- The pooled held-out point estimate favours Balanced Plus (**${sg(p.meanDiff)} points per five-gameweek window**, ≈ ${sg(p.meanDiff / 5)} per gameweek), but **both 95% intervals are consistent with no difference** (t: ${ci(p.tCI95NonOverlapping)}; block bootstrap: ${ci(p.blockBootstrapCI95)}), the **median is ${sg(p.medianDiff)}** (a few large windows drive the mean), the sign test is far from significant (${p.signTest.wins} wins / ${p.signTest.losses} losses, p = ${p.signTest.p.toFixed(2)}), and the **two held-out seasons disagree in sign** (${perSeason}).
- The development season showed ${sg(dev.meanDiff)} per window. The held-out seasons show much less. A large effect that shrinks out of sample is what chance plus a small sample looks like; it is not evidence of a durable edge.
- The evidence standard: the backtest code (fixed before the run) labels a difference as evidence only if **both** 95% intervals exclude zero. The verdict logic added afterwards, when this report was written, also requires the same sign in every held-out season; that extra clause cannot change this verdict because the first condition already fails. Balanced Plus does not meet the standard. It also does not underperform: its average rank (${f(ev.windowResults["balanced-plus"].averageRank, 2)}) equals Balanced's (${f(ev.windowResults["balanced"].averageRank, 2)}).
- **Statistical power is the limiting factor.** With ${p.nNonOverlapping} independent windows and a window-difference SD of ${f(p.sdDiff)}, the study can only detect a difference of about **${f(mde, 0)} points per window (≈ ${f(mde / 5, 1)} per gameweek)** with 80% power. Detecting a real 2-points-per-gameweek edge would need on the order of **${needed} independent windows**, about ${Math.ceil(needed / 6)} seasons of non-overlapping windows.

## Methodology

**Question.** Does the Balanced Plus selection process produce more actual FPL points than Balanced, Safe and Aggressive when each is applied only with information available at the time?

**Unit of evaluation: a five-gameweek window.** At the deadline of gameweek *k* each strategy builds a legal 15-man squad (£100m, max 3 per club, 2/5/5/3) from point-in-time data using its **own** selection rule (Balanced, Safe, Aggressive: the unchanged optimiser; Balanced Plus: its own solver). The squad is held for GW *k…k+4* (no transfers, chips or price changes). At every gameweek the strategy's own lineup rule re-selects XI, bench order, captain and vice from data available at **that** gameweek's deadline (Balanced/Safe/Aggressive: the unchanged \`bestLineup\`; Balanced Plus: its XI rule with the 2-per-club cap and secure-starter bars, relaxing them in a fixed order only if the squad cannot satisfy them, which happened in ${f(100 * ev.strategies.find((x: any) => x.id === "balanced-plus").lineupRelaxedShare)}% of gameweeks). Actual points then apply FPL's automatic substitutions and the vice-captain rule.

**Windows.** *k* = 6…34 per season (≥ 5 gameweeks of history; ≥ 5 gameweeks left): 29 rolling windows per season, of which 6 share no gameweek. All four strategies are scored on exactly the same windows.

**Splits and no tuning.**

| Role | Season | Use |
|---|---|---|
| Development | 2023-24 | verify the harness only; no parameter was chosen from it |
| **Held-out evaluation** | **2024-25, 2025-26** | **the conclusion** |
| Attempted, excluded | 2022-23 | rejected by the data-quality gate (below) |
| Not used | 2026-27 (live) | only 1 usable window (10 gameweeks played; windows need 5 prior and 5 following gameweeks) |

Strategy code and parameters are frozen (\`data/backtest-frozen.json\`: SHA-256 of the optimiser, projection engine and Balanced Plus source plus its parameters) and the backtest refuses to run if they change. **No strategy weight or threshold was tuned against any window.** The sensitivity analysis below is descriptive.

**Statistics.**

- Paired differences (strategy minus Balanced) on window totals.
- Overlapping windows are serially dependent, so inference uses (a) a **t interval on the non-overlapping windows** and (b) a **moving-block bootstrap (blocks of 5 windows, 5,000 resamples, fixed seed) on all rolling windows**; plus an exact sign test on the non-overlapping windows. Effect size = mean difference / SD.
- "Evidence" is claimed only if both intervals exclude zero. Everything else is labelled *no evidence of difference*, which is **not** the same as *evidence of no difference*.
- Rotation split, formation tables, captain and bench metrics are **descriptive** (heuristic reading, not tested).

## Data

**Source.** Public dataset [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) (per-gameweek player rows scraped from the FPL API, fixtures, teams), frozen in \`data/historical/\` with SHA-256 hashes and upstream commit \`${r.data.upstreamCommit}\` (fetched ${r.data.fetchedAt}). The backtest verifies the hashes on every run and reads no network. Real data only; nothing was synthesised.

| Season | Role | Players | Gameweeks with fixtures | Defensive-contribution scoring | First window |
|---|---|---:|---:|---|---:|
${Object.entries(r.coverage).map(([s, c]: [string, any]) => `| ${s} | ${c.role} | ${c.players} | ${c.gameweeksWithFixtures} | ${c.defensiveContribution ? "yes" : "no"} | GW${c.firstWindowStart} |`).join("\n")}

**2022-23 exclusion.** The source has **no \`starts\` for GW1-15 and no xG/xA for GW1-14**, so a start probability and attacking rates cannot be formed. An automatic gate (every earlier gameweek must carry starts for ≥ 80% of 60+ minute rows and xG/xA for ≥ 40% of played rows) rejected every window. Before the gate existed, Balanced Plus found *no legal squad at all* in 2022-23 (no player passed the secure-starter bar), which is how the problem was found. The data was not patched. Also GW7 is absent from that season.

### Point-in-time construction and leakage controls

${r.assumptions.map((a: string) => `- ${a}`).join("\n")}

Leakage checks (automated, in \`tests/balancedPlusBacktest.test.ts\`):

1. Corrupting **every** row, price, ownership figure and outcome from the deadline onward leaves the point-in-time dataset byte-identical, and leaves every strategy's squad and first-gameweek lineup identical, while the scored points change.
2. Fixtures count as finished only if their gameweek precedes the deadline; prices are the previous gameweek's.
3. The three existing strategies in the harness equal a direct call of the unchanged optimiser on the same point-in-time data.
4. The availability proxy is built from past minutes only and can be switched off.

### Known contamination that cannot be removed

- **Injury/availability news** has no point-in-time source. A past-minutes proxy is used for all strategies; with the proxy off (everyone available) the conclusion is unchanged (BP ${sg(none.meanDiff)}, block-bootstrap CI ${ci(none.blockBootstrapCI95)}).
- The **fixture list is the final schedule** (rearranged fixtures appear in their final gameweek).
- **Prices** are up to ~7 days stale; the third-party scrape is assumed accurate.
- Players with no row before a deadline are invisible (new signings), identically for all strategies.
- Strategies hold a fixed squad: this tests selection quality, not transfer management, chips or price changes.

## Results (held-out: 2024-25 and 2025-26)

${strategyTable(ev, "Comparison table, pooled held-out seasons")}

${strategyTable(r.evaluation.perSeason["2024-25"], "2024-25")}

${strategyTable(r.evaluation.perSeason["2025-26"], "2025-26")}

${strategyTable(r.development, "Development season 2023-24 (harness check, not evidence)")}

### Win rates and ranking

Share of windows in which each strategy scored the most points (ties shared), and average rank:

${md([["Strategy", "Held-out: windows won %", "Outright wins %", "Average rank", "Development: windows won %", "Development: avg rank"], ...ev.strategies.map((x: any) => [x.label, f(ev.windowResults[x.id].sharedWinPct), f(ev.windowResults[x.id].outrightWinPct), f(ev.windowResults[x.id].averageRank, 2), f(r.development.windowResults[x.id].sharedWinPct), f(r.development.windowResults[x.id].averageRank, 2)])])}

A four-way "win %" favours the highest-variance strategy and a chance level is 25%. The average ranks are nearly identical.

### Detailed metrics (pooled held-out)

${detail(ev)}

Reading notes: *actual* includes automatic substitutions (worth ${f(ev.strategies[0].bench.pointsAddedByAutoSubsPerGw, 1)}-${f(ev.strategies[3].bench.pointsAddedByAutoSubsPerGw, 1)} pts/GW) which the projection does not model, so every strategy's projection under-predicts by ~3.5-4.9 pts/GW; this is a model calibration finding common to all four, not specific to Balanced Plus. Selecting players the model rates highly also increases the gap (winner's curse), most for the strategy with the most selective rules.

### Club concentration, availability and bench

- The **2-per-club rule works as designed** (mean max from one club in the XI ${f(ev.strategies[3].clubConcentration.meanMaxFromOneClubInXI, 2)} vs ${f(ev.strategies[0].clubConcentration.meanMaxFromOneClubInXI, 2)}; 3+ from one club in ${f(100 * ev.strategies[0].clubConcentration.shareOfGwsWith3Plus, 0)}% of Balanced gameweeks and 0% of Balanced Plus ones) **at no measurable cost in points**.
- The **secure-minutes rule did not measurably reduce non-playing starters in the held-out seasons** (${f(100 * ev.strategies[3].startingXI.didNotPlayRate)}% vs ${f(100 * ev.strategies[0].startingXI.didNotPlayRate)}%; minutes per starter ${f(ev.strategies[3].startingXI.meanMinutesPerStarter)} vs ${f(ev.strategies[0].startingXI.meanMinutesPerStarter)}). In the development season it did (1.10 vs 1.28 non-playing starters per gameweek), another sign that the development effect did not carry over.
- Balanced Plus's bench adds slightly more through auto-subs (${f(ev.strategies[3].bench.pointsAddedByAutoSubsPerGw, 2)} vs ${f(ev.strategies[0].bench.pointsAddedByAutoSubsPerGw, 2)} pts/GW) and leaves more points unused on the bench (${f(ev.strategies[3].bench.unusedBenchPointsPerGw)} vs ${f(ev.strategies[0].bench.unusedBenchPointsPerGw)}), consistent with a deliberately stronger bench.

### Performance by formation

${formationTable(ev)}

Only 3-4-3 and 3-5-2 have meaningful samples; Balanced Plus plays 3-5-2 more often. Other formations have a handful of gameweeks and should not be interpreted.

### High- versus low-rotation periods

Windows are classified after the fact by the share of regular starters (≥ 70% of starts) who played < 60 minutes in the window's gameweeks (median split; the index is **never** used for selection). Descriptive only: windows overlap and no interval is computed.

${rotation(ev)}

## Statistical evaluation: Balanced Plus minus Balanced

${pairedTable([["Held-out pooled (primary)", bp(ev)], ["2024-25", bp(r.evaluation.perSeason["2024-25"])], ["2025-26", bp(r.evaluation.perSeason["2025-26"])], ["Held-out, availability proxy OFF", bp(r.sensitivity.availabilityProxyOff)], ["Development 2023-24 (not evidence)", bp(r.development)], ["All three seasons pooled (not a held-out test)", bp(r.allSeasonsPooled)]])}

Safe and Aggressive versus Balanced (pooled held-out): Safe ${sg(ev.pairedVsBaseline.safe.meanDiff)} ${ci(ev.pairedVsBaseline.safe.blockBootstrapCI95)}, Aggressive ${sg(ev.pairedVsBaseline.aggressive.meanDiff)} ${ci(ev.pairedVsBaseline.aggressive.blockBootstrapCI95)} (block-bootstrap); neither is distinguishable from Balanced.

**What is statistical evidence and what is heuristic.**

| Statistical (supports an inference about performance) | Heuristic / descriptive (does not) |
|---|---|
| paired differences, t interval on non-overlapping windows, block bootstrap, sign test, window ranks | rotation split, formation table, captain and bench metrics, ablation table |
| the stated decision rule (both intervals exclude 0, same sign in each held-out season) | every Balanced Plus threshold (75% / 60 min / 50% / bench 12 / weights), the minutes-security formula, the discount weights |
| leakage tests, frozen strategy hashes | the availability proxy and the choice of a 5-gameweek hold |

## Sensitivity (descriptive; nothing was selected from it)

Ablations of Balanced Plus on the held-out seasons (same windows). Many variants were examined, so isolated intervals that exclude zero (e.g. the no-security row against default Balanced Plus) are **exploratory and subject to multiple comparisons**; the t interval on non-overlapping windows includes zero for every row.

${sens()}

- **Discount weights** (flat, default, front-loaded): differences between them are ≈ ±2 points per window, far inside the noise. The five-gameweek weighting is not what drives results.
- **Without the minutes-security multiplier** the point estimate is *higher* (${sg(r.sensitivity.vsBalancedPlus.pairedVsBaseline["bp-no-security"].meanDiff)} vs default Balanced Plus), i.e. the multiplier did not help here. Not established, but no support for it.
- **Keeping form and realised goals/assists** (undoing the xG-only and form-removal ingredients) is also higher by ${sg(r.sensitivity.vsBalancedPlus.pairedVsBaseline["bp-keep-form-and-realised"].meanDiff)}: no support for the claim that removing them improves results.
- **Without the club cap**: ${sg(r.sensitivity.vsBalancedPlus.pairedVsBaseline["bp-no-club-cap"].meanDiff)}: the cap is points-neutral, as above.

## Limitations

- **Two held-out seasons and 12 independent windows** is a small sample; the study cannot detect edges below roughly ${f(mde / 5, 1)} points per gameweek.
- Single-hold strategy test (no transfers, chips or price changes): it says nothing about season-long play.
- No point-in-time injury news; the proxy is crude. (No point-in-time injury or availability source exists.)
- Final fixture schedule (rearranged fixtures appear in their final gameweek); stale prices (up to ~7 days); third-party data. Also 2022-23 is excluded and 2026-27 is unused.
- Selection rules were designed knowing 2026-27 data and general FPL experience; the held-out seasons are out-of-sample for the *parameters* (not tuned) but not for the *ideas*.
- The ablation analysis explores many variants (multiple-comparison risk).

## Reproduce

\`\`\`bash
npm run backtest:fetch      # optional: re-download and re-freeze the historical data (changes the upstream commit)
npm run backtest:bp         # run everything (a few minutes); verifies hashes and the strategy freeze
npx tsx scripts/backtest/make-backtest-doc.ts
npm test
\`\`\`

Files: \`docs/backtest/balanced-plus-backtest-results.json\` (all summaries, assumptions, skipped windows), \`windows.csv\` (one row per window and strategy), \`gameweeks.csv\` (one row per gameweek, strategy and window), \`comparison-table.json\`, \`data/backtest-frozen.json\`, \`data/historical/manifest.json\`.
`;
writeFileSync("docs/BALANCED_PLUS_BACKTEST.md", doc);
console.log("wrote docs/BALANCED_PLUS_BACKTEST.md", doc.length, "chars; verdict:", val.verdict);
