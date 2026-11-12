import type { Dataset } from "../fpl/types";
import { findAlternatives } from "../optimizer/alternatives";
import { buildReport, type ReportInput } from "../report/build";
import { renderReportPdf, type PdfHelpers } from "../report/pdf";
import type { Horizon } from "../season/horizon";
import { BALANCED_PLUS, optimizeBalancedPlus, type BalancedPlusResult } from "./balancedPlus";
import { compareAll, existingStrategies } from "./compare";
import { BACKTEST_LIMITATIONS, loadValidationSummary } from "./validation";

type Comparison = ReturnType<typeof compareAll>;

export function strategyDefinition() {
  const B = BALANCED_PLUS;
  return {
    name: B.name,
    summary: "A fourth strategy next to Balanced, Safe and Aggressive: a diversified, minutes-secure squad judged over five gameweeks, built on underlying xG/xA rather than recent form.",
    rules: [
      `At most ${B.maxPerClubXI} players from any one club in the starting XI (the squad still obeys the FPL limit of 3).`,
      `XI players must be secure starters: start probability >= ${B.xiMinStartProb * 100}%, >= ${B.xiMinExpMinutes} expected minutes, availability >= ${B.xiMinAvailability * 100}%.`,
      "Objective value = discounted xPts over the next five gameweeks (weights 1 / 0.9 / 0.8 / 0.7 / 0.6), scaled by minutes security (0.6 + 0.2 x start probability + 0.2 x min(1, expected minutes / 80)).",
      "Inside the objective, the player's own goal and assist terms are rebuilt from xG and xA only (realised goals and assists are excluded from those two terms). Bonus points, defensive contribution, saves, cards, team goals conceded and minutes/starts still come from realised data, exactly as in the shared projection model.",
      "The recent-form tilt is removed from the objective. It is NOT removed from the displayed xPts or breakdown, and captaincy is chosen from the displayed xPts, so form can still influence the armband.",
      `Strong playable bench: every outfield sub must have >= ${B.benchMinStartProb * 100}% start probability, the bench counts for ${B.benchWeight * 100}% of a starter's value (Balanced: 12%), and the four bench players must total >= 12 xPts when feasible.`,
      "Captain = highest displayed (raw model) xPts in the XI, chosen independently of the squad objective. Vice = best remaining secure starter (>= 85% start) from a different club to the captain.",
      "Same FPL data snapshot and same £100m budget as the other three strategies.",
    ],
    methodology: {
      objectiveVersusDisplayedXpts:
        "Two different numbers exist for every player. DISPLAYED xPts (tables, breakdown, captaincy, comparison metrics) come from the shared projection engine used by all four strategies. The Balanced Plus OBJECTIVE VALUE (what the solver maximises) is a separate five-gameweek quantity derived from it. The per-player table in this report shows both.",
      realisedDataInDisplayedXpts: "goals and assists: 80% xG/xA + 20% realised; bonus, saves, defensive contribution and cards: realised per-90 rates; clean sheets and goals conceded: team goals against (50% realised) and xGA; minutes and starts: realised; positional priors include realised totals.",
      realisedDataInObjective: "Excluded: the player's own realised goals and assists. Still included: bonus, defensive contribution, saves, cards, team goals conceded, minutes and starts.",
      form: "Removed from the objective only. Present in displayed xPts (mean absolute size about 0.03 xPts per player; up to ~0.3) and therefore in captaincy.",
      minutesSecurity: "Applied on top of a projection that already scales by expected minutes, so minutes are deliberately counted twice.",
    },
    parameters: { ...B, benchTargets: [...B.benchTargets] },
  };
}

function summaryLines(c: Comparison): string[] {
  const m = Object.fromEntries(c.metrics.map((x) => [x.key, x])) as Record<string, (typeof c.metrics)[number]>;
  const bp = m["balanced-plus"];
  const lines: string[] = [];
  for (const k of ["balanced", "safe", "aggressive"]) {
    const o = m[k];
    lines.push(
      `vs ${o.label}: GW${c.gw} xPts ${bp.gw0Xpts >= o.gw0Xpts ? "+" : ""}${(bp.gw0Xpts - o.gw0Xpts).toFixed(2)}, five-gameweek xPts ${bp.fiveGwXpts >= o.fiveGwXpts ? "+" : ""}${(bp.fiveGwXpts - o.fiveGwXpts).toFixed(2)}, max per club in XI ${bp.maxClubInXI} vs ${o.maxClubInXI}, XI form-tilt xPts ${bp.xiFormTiltXpts.toFixed(2)} vs ${o.xiFormTiltXpts.toFixed(2)}, XI xGI/90 ${bp.xiXgi90Outfield.toFixed(2)} vs ${o.xiXgi90Outfield.toFixed(2)}.`,
    );
  }
  return lines;
}

type ObjRow = { name: string; displayedXptsGw: number; objectiveValueGw: number; displayedXpts5Gw: number; objectiveValue5Gw: number; formXptsRemoved5Gw: number; xgxaRebuild5Gw: number; startProb: number };

function appendix(def: ReturnType<typeof strategyDefinition>, c: Comparison, objective: ObjRow[], validation: ReturnType<typeof loadValidationSummary>): (h: PdfHelpers) => void {
  return ({ h1, para, table, ensure, doc, width }) => {
    h1("Balanced Plus: strategy definition");
    para(def.summary, { size: 8.5 });
    def.rules.forEach((r) => para(`• ${r}`, { size: 8, indent: 8 }));

    h1("What the Balanced Plus objective uses, and what this report displays");
    const m = def.methodology;
    para(m.objectiveVersusDisplayedXpts, { size: 8 });
    para(`Displayed xPts use realised data as follows: ${m.realisedDataInDisplayedXpts}`, { size: 8 });
    para(`Objective: ${m.realisedDataInObjective}`, { size: 8 });
    para(`Form: ${m.form}`, { size: 8 });
    para(`Minutes: ${m.minutesSecurity}`, { size: 8 });
    if (objective.length) {
      para("Displayed = shared-model xPts (GW = this gameweek, 5-GW = discounted average). Objective = the Balanced Plus value the solver maximised. Form xPts removed and the xG/xA rebuild are the 5-GW adjustments between the two.", { size: 7.5, color: "#667085" });
      ensure(80);
      table(
        [{ label: "Player", w: 120 }, { label: "Displayed GW", w: 100, align: "right" }, { label: "Objective GW", w: 100, align: "right" }, { label: "Displayed 5-GW", w: 110, align: "right" }, { label: "Objective 5-GW", w: 110, align: "right" }, { label: "Form xPts removed", w: 90, align: "right" }, { label: "xG/xA rebuild", w: 80, align: "right" }, { label: "Start %", w: width - 710, align: "right" }],
        objective.map((o) => [o.name, o.displayedXptsGw.toFixed(2), o.objectiveValueGw.toFixed(2), o.displayedXpts5Gw.toFixed(2), o.objectiveValue5Gw.toFixed(2), o.formXptsRemoved5Gw.toFixed(2), o.xgxaRebuild5Gw.toFixed(2), `${Math.round(o.startProb * 100)}%`]),
        { size: 7.2 },
      );
    }
    if (validation.available) {
      h1("Historical validation (rolling backtest)");
      para(validation.headline!, { bold: true, size: 9 });
      validation.lines!.forEach((l) => para(`• ${l}`, { size: 8, indent: 8 }));
      para("Limitations of this validation:", { bold: true, size: 8 });
      BACKTEST_LIMITATIONS.forEach((l) => para(`• ${l}`, { size: 7.8, indent: 8 }));
      para("Full method, data limits and sensitivity analysis: docs/BALANCED_PLUS_BACKTEST.md. A difference is claimed only if both 95% intervals exclude zero and the sign agrees in each held-out season.", { size: 7.5, color: "#667085" });
    }

    h1("Strategy comparison: Balanced Plus vs Balanced, Safe and Aggressive (same data snapshot, £100m)");
    ensure(120);
    const labels = c.metrics.map((m) => m.label);
    const row = (name: string, f: (m: (typeof c.metrics)[number]) => string) => [name, ...c.metrics.map(f)];
    const w1 = 190;
    const wc = (width - w1) / 4;
    table(
      [{ label: "Metric", w: w1 }, ...labels.map((l) => ({ label: l, w: wc }))],
      [
        row("Formation", (m) => m.formation),
        row("Squad cost / bank", (m) => `£${m.costM.toFixed(1)}m / £${m.bankM.toFixed(1)}m`),
        row(`GW${c.gw} xPts (XI + captain)`, (m) => m.gw0Xpts.toFixed(2)),
        row("Five-gameweek xPts (sum)", (m) => m.fiveGwXpts.toFixed(2)),
        row("Five-gameweek xPts (discounted)", (m) => m.fiveGwDiscounted.toFixed(2)),
        row("xPts per gameweek", (m) => m.perGw.map((v) => v.toFixed(1)).join(" / ")),
        row("Max players from one club in XI", (m) => String(m.maxClubInXI)),
        row("Clubs with 3+ in XI", (m) => m.clubsOverTwoInXI.join(", ") || "none"),
        row("XI avg / min start probability", (m) => `${Math.round(m.xiAvgStartProb * 100)}% / ${Math.round(m.xiMinStartProb * 100)}%`),
        row("XI avg expected minutes", (m) => String(m.xiAvgExpMinutes)),
        row("XI players below the security bar", (m) => (m.xiBelowSecurityBar.length ? m.xiBelowSecurityBar.join(", ") : "none")),
        row(`Bench xPts (GW${c.gw}) / outfield start prob`, (m) => `${m.benchXpts.toFixed(1)} / ${Math.round(m.benchAvgStartProb * 100)}%`),
        row("XI outfield xGI per 90 (sum)", (m) => m.xiXgi90Outfield.toFixed(2)),
        row("Assist share of XI xGI", (m) => `${Math.round(m.xiAssistShareOfXgi * 100)}%`),
        row("Displayed form tilt inside XI xPts (not in the BP objective)", (m) => m.xiFormTiltXpts.toFixed(2)),
        row("Average model confidence", (m) => `${Math.round(m.avgConfidence * 100)}%`),
        row("Captain (xPts, start %)", (m) => `${m.captain.name} (${m.captain.xpts.toFixed(2)}, ${Math.round(m.captain.startProb * 100)}%)`),
        row("Vice-captain (same club as captain?)", (m) => `${m.vice.name}${m.vice.sameClubAsCaptain ? " (same club)" : ""}`),
      ],
      { size: 7.2, boldFirst: true },
    );
    c.notes.forEach((n) => para(n, { size: 7.5, color: "#667085" }));
    para("Summary", { bold: true, size: 9 });
    summaryLines(c).forEach((l) => para(`• ${l}`, { size: 8, indent: 8 }));

    for (const ch of c.changes) {
      h1(`Balanced Plus vs ${ch.againstLabel}: ${ch.changedPlayers} player change(s), ${ch.roleChanges.length} role change(s), ${ch.overlap}/15 players shared`);
      if (ch.swaps.length) {
        ensure(70);
        table(
          [{ label: "Pos", w: 30 }, { label: `Out (${ch.againstLabel})`, w: 190 }, { label: "In (Balanced Plus)", w: 190 }, { label: `GW${c.gw} xPts`, w: 70, align: "right" }, { label: "5-GW value", w: width - 480, align: "right" }],
          ch.swaps.map((s) => [s.position, `${s.out.name} (${s.out.club}, £${s.out.priceM.toFixed(1)}m, ${s.out.role})`, `${s.in.name} (${s.in.club}, £${s.in.priceM.toFixed(1)}m, ${s.in.role})`, `${s.out.gw0Xpts.toFixed(2)} -> ${s.in.gw0Xpts.toFixed(2)}`, `${s.out.fiveGwValue.toFixed(2)} -> ${s.in.fiveGwValue.toFixed(2)}`]),
          { size: 7.2 },
        );
        for (const s of ch.swaps) {
          ensure(40);
          doc.font("bold").fontSize(8).fillColor("#37003c").text(`${s.out.name} -> ${s.in.name}`, 30, doc.y, { width });
          doc.font("reg").fontSize(7.6).fillColor("#111");
          s.whyOut.forEach((w) => doc.text(`Out: ${w}`, 40, doc.y, { width: width - 10 }));
          s.whyIn.forEach((w) => doc.text(`In: ${w}`, 40, doc.y, { width: width - 10 }));
          doc.moveDown(0.25);
        }
      } else para("No players differ; only roles and captaincy differ.", { size: 8 });
      if (ch.roleChanges.length) {
        para("Role changes (same player, different role):", { bold: true, size: 8.5 });
        ch.roleChanges.forEach((r) => para(`• ${r.explanation}`, { size: 7.8, indent: 8 }));
      }
      para(ch.captaincy.explanation, { size: 7.8 });
    }
  };
}

export interface BalancedPlusDoc {
  bp: BalancedPlusResult;
  comparison: Comparison;
  definition: ReturnType<typeof strategyDefinition>;
  report: Awaited<ReturnType<typeof buildReport>> & Record<string, unknown>;
  pdf: () => Promise<Buffer>;
}

/** Builds the Balanced Plus squad, the comparison with the three existing strategies, and the report object. */
export async function buildBalancedPlusDoc(ds: Dataset, gw: number, hz: Horizon): Promise<BalancedPlusDoc> {
  const bp = optimizeBalancedPlus(ds, hz);
  const baselines = existingStrategies(ds, gw);
  const comparison = compareAll(ds, hz, bp, baselines);
  const definition = strategyDefinition();
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const objective: ObjRow[] = bp.squad.map((id) => { const v = bp.values.get(id)!; return { name: by.get(id)!.webName, displayedXptsGw: v.ep0, objectiveValueGw: v.value0, displayedXpts5Gw: v.rawEp5, objectiveValue5Gw: v.value, formXptsRemoved5Gw: v.formRemoved5, xgxaRebuild5Gw: v.attackShift5, startProb: v.startProb }; });
  const validation = loadValidationSummary();
  const shortlist: NonNullable<ReportInput["shortlist"]> = {};
  for (const id of bp.squad) {
    const r = findAlternatives(ds, hz.display, bp.squad, id, { mode: "balanced" }, 3);
    shortlist[id] = r.alternatives.map((a) => ({ id: a.playerId, ep: a.ep, costM: by.get(a.playerId)!.cost, deltaEp: a.deltaEp }));
  }
  const base = await buildReport({
    kind: "builder", ds, gw, hz, display: hz.display, starting: bp.starting, bench: bp.bench, captain: bp.captain, vice: bp.viceCaptain,
    formation: bp.formation, mode: "balanced-plus", shortlist, totalCostM: bp.totalCostTenths / 10, remainingM: bp.remainingTenths / 10, projectedPoints: bp.expectedPoints,
  });
  const report = {
    ...base,
    title: `Gameweek ${gw} Intelligence Report: Balanced Plus`,
    squadSource: "Balanced Plus (fourth strategy) squad, generated from the same FPL data snapshot and £100m budget as Balanced, Safe and Aggressive",
    strategy: { ...definition, playerObjective: objective, historicalValidation: validation },
    strategyComparison: {
      note: "Balanced, Safe and Aggressive come from the unchanged optimiser. Every changed player has an explanation.",
      captaincy: { ranking: bp.captaincy.ranking.map((r) => ({ name: by.get(r.id)!.webName, xPts: r.ep, startProbability: r.startProb })), viceRule: bp.captaincy.viceRule },
      bench: { totalXpts: bp.benchEp, targetMet: bp.benchTargetMet },
      ...comparison,
    },
  } as Awaited<ReturnType<typeof buildReport>> & Record<string, unknown>;
  return { bp, comparison, definition, report, pdf: () => renderReportPdf(report, appendix(definition, comparison, objective, validation)) };
}
