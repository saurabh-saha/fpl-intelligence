import type { Dataset, Player, Preferences, Projection } from "../fpl/types";
import { attackRate, averageDifficulty, defenceRate } from "./fixtureAnalysis";
import { buildModelContext, projectPlayer, round2, type ModelContext } from "./expectedPoints";

/** Fixture-run weights used when "favour upcoming fixture runs" is on (GW, GW+1, GW+2). */
export const RUN_WEIGHTS = [1, 0.5, 0.35];

export function selectionScore(p: Player, proj: Projection, prefs: Preferences): number {
  const diffPref = prefs.differential ?? (prefs.mode === "aggressive" ? 0.6 : 0);
  const rarity = Math.max(0, (25 - p.ownership) / 25); // 1 at 0% owned, 0 at >=25%
  switch (prefs.mode) {
    case "safe":
      return proj.ep * (0.5 + 0.5 * proj.startProb) * (0.8 + 0.2 * proj.confidenceScore) * (1 + diffPref * 0.35 * rarity);
    case "aggressive":
      return proj.ep * (0.85 + 0.15 * proj.startProb) * (1 + diffPref * 0.35 * rarity);
    default:
      return proj.ep * (0.9 + 0.1 * proj.startProb) * (1 + diffPref * 0.35 * rarity);
  }
}

export interface ProjectionSet {
  ctx: ModelContext;
  byId: Map<number, Projection>;
}

/** Project every player for `gw` and attach the mode-dependent selection score, reasons and warnings. */
export function projectAll(ds: Dataset, gw: number, prefs: Preferences = { mode: "balanced" }): ProjectionSet {
  const ctx = buildModelContext(ds, gw);
  const horizon = prefs.favourFixtureRuns ? RUN_WEIGHTS.length : 1;
  const byId = new Map<number, Projection>();
  const lastGw = ds.events[ds.events.length - 1]?.id ?? gw;

  for (const p of ds.players) {
    const proj = projectPlayer(p, ctx);
    let blended = proj.ep;
    if (horizon > 1) {
      let num = proj.ep * RUN_WEIGHTS[0];
      let den = RUN_WEIGHTS[0];
      for (let k = 1; k < horizon; k++) {
        if (gw + k > lastGw) break;
        num += projectPlayer(p, ctx, gw + k).ep * RUN_WEIGHTS[k];
        den += RUN_WEIGHTS[k];
      }
      blended = num / den;
    }
    const sel = selectionScore(p, { ...proj, ep: blended }, prefs);
    proj.score = round2(sel);
    byId.set(p.id, proj);
  }

  // Ranks + explanations need the whole field.
  const rank = new Map<number, number>();
  const sizeByPos: Record<string, number> = {};
  for (const pos of ["GKP", "DEF", "MID", "FWD"] as const) {
    const ps = ds.players.filter((p) => p.pos === pos).sort((a, b) => byId.get(b.id)!.ep - byId.get(a.id)!.ep);
    sizeByPos[pos] = ps.length;
    ps.forEach((p, i) => rank.set(p.id, i + 1));
  }
  for (const p of ds.players) {
    const proj = byId.get(p.id)!;
    explain(p, proj, ctx, rank.get(p.id)!, sizeByPos[p.pos]);
  }
  return { ctx, byId };
}

export function explain(p: Player, proj: Projection, ctx: ModelContext, rank: number, ofPos: number) {
  const { ds, lg } = ctx;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const fx = proj.fixtures;

  if (fx.length === 0) {
    warnings.push("No fixture in this gameweek.");
    proj.reasons = reasons;
    proj.warnings = warnings;
    return;
  }

  // Output
  if (p.pos === "GKP") {
    if (p.cleanSheets > 0) reasons.push(`${p.cleanSheets} clean sheets and ${p.saves} saves this season.`);
  } else if (p.goals + p.assists > 0) {
    reasons.push(`${p.goals} goals and ${p.assists} assists this season (xGI ${p.xGI.toFixed(1)}).`);
  }
  if (p.pos !== "GKP" && p.xGI90 >= 0.3) reasons.push(`Strong underlying attacking numbers: ${p.xGI90.toFixed(2)} xGI per 90.`);
  if (p.pos === "DEF" && p.cleanSheets >= 4) reasons.push(`Defensive returns: ${p.cleanSheets} clean sheets.`);
  if (p.pos === "DEF" && proj.components.defContrib >= 0.7) reasons.push("Regularly reaches the defensive-contribution threshold.");
  if (p.penaltiesOrder === 1) reasons.push("First-choice penalty taker.");

  // Minutes
  if (proj.startProb >= 0.85 && proj.availability >= 0.9) reasons.push("Regular starter with secure minutes.");

  // Fixtures
  for (const f of fx) {
    const opp = ds.teams[f.oppId];
    if (!opp) continue;
    const conceded = defenceRate(opp, lg);
    const scored = attackRate(opp, lg);
    const venue = f.home ? "home" : "away";
    if (p.pos === "GKP" || p.pos === "DEF") {
      if (scored < lg.goalsPerGame * 0.85) reasons.push(`${opp.short} (${venue}) are a low-scoring side: good clean-sheet odds.`);
    } else if (conceded > lg.goalsPerGame * 1.1) {
      reasons.push(`${opp.short} (${venue}) concede ${conceded.toFixed(2)} goals/game vs league ${lg.goalsPerGame.toFixed(2)}.`);
    }
    if (f.difficulty >= 4) warnings.push(`Difficult fixture: ${opp.short} (${venue}), FDR ${f.difficulty}.`);
    else if (f.difficulty <= 2) reasons.push(`Favourable fixture: ${opp.short} (${venue}), FDR ${f.difficulty}.`);
  }
  if (fx.length > 1) reasons.push(`Double gameweek: ${fx.length} fixtures.`);

  reasons.push(`Projects ${proj.ep.toFixed(1)} pts, #${rank} of ${ofPos} ${p.pos}s this gameweek.`);

  // Warnings (only what the data supports)
  if (proj.availability < 1) {
    const msg = p.news ? `Availability: ${p.news}` : `Availability doubt (${Math.round(proj.availability * 100)}% likely to play).`;
    warnings.push(msg);
  }
  if (proj.startProb < 0.6 && proj.availability > 0) warnings.push("Limited playing time: not a guaranteed starter.");
  if (proj.confidence === "low") warnings.push("Low confidence: small sample of minutes or uncertain availability.");
  if (p.pos !== "GKP" && p.minutes >= 450 && p.goals + p.assists > 2 * (p.xGI + 0.5) && p.goals + p.assists >= 4) {
    warnings.push("Returns well above xGI: some regression is likely.");
  }
  if (p.pos !== "GKP" && p.minutes >= 900 && p.xGI90 < 0.08 && p.pos !== "DEF") warnings.push("Poor recent underlying numbers (low xGI per 90).");
  if (averageDifficulty(fx) >= 4 && !warnings.some((w) => w.startsWith("Difficult"))) warnings.push("Difficult fixtures.");

  proj.reasons = reasons;
  proj.warnings = warnings;
}
