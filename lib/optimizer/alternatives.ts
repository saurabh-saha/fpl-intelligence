import type { Dataset, Player, Preferences, Projection, SquadResult } from "../fpl/types";
import { buildResult } from "./formationOptimizer";
import { validateSquad } from "./validation";

export interface Alternative {
  playerId: number;
  ep: number;
  /** squad expected points after the swap minus before (captain doubling included) */
  deltaEp: number;
  /** price difference in tenths: positive = costs more */
  deltaCostTenths: number;
  remainingTenths: number;
}

export interface AlternativesOutput {
  current: SquadResult;
  alternatives: Alternative[];
}

/** Re-derive formation, bench, captain and expected points for an arbitrary (valid) 15-man squad. */
export function evaluateSquad(
  ds: Dataset,
  proj: Map<number, Projection>,
  ids: number[],
  prefs: Preferences,
): SquadResult {
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const budget = prefs.overCap && prefs.budgetTenths ? prefs.budgetTenths : Math.min(prefs.budgetTenths ?? ds.rules.budgetTenths, ds.rules.budgetTenths);
  const v = validateSquad(ids, byId, ds.rules, Math.max(budget, 0));
  // Budget is only a hard error for *generation*; an already-chosen squad may sit at the cap.
  const hard = v.errors.filter((e) => !e.startsWith("Over budget"));
  if (hard.length) throw new Error(hard.join(" "));
  const squad = ids.map((id) => byId.get(id)!);
  return buildResult(squad, proj, ds.rules, budget, prefs.formation);
}

/**
 * Replacement candidates for `outId`: same position, not already owned, and the resulting squad
 * must satisfy budget + club limits. Each is annotated with the change in squad expected points.
 */
export function findAlternatives(
  ds: Dataset,
  proj: Map<number, Projection>,
  squadIds: number[],
  outId: number,
  prefs: Preferences,
  limit = 60,
): AlternativesOutput {
  const byId = new Map<number, Player>(ds.players.map((p) => [p.id, p]));
  const out = byId.get(outId);
  if (!out || !squadIds.includes(outId)) throw new Error("Player is not in the squad.");
  const budget = prefs.overCap && prefs.budgetTenths ? prefs.budgetTenths : Math.min(prefs.budgetTenths ?? ds.rules.budgetTenths, ds.rules.budgetTenths);
  const current = evaluateSquad(ds, proj, squadIds, prefs);
  const owned = new Set(squadIds);

  const alts: Alternative[] = [];
  for (const cand of ds.players) {
    if (cand.pos !== out.pos || owned.has(cand.id)) continue;
    if (["u", "s", "n"].includes(cand.status)) continue;
    if (prefs.maxOwnership != null && cand.ownership > prefs.maxOwnership) continue;
    const next = squadIds.map((id) => (id === outId ? cand.id : id));
    if (!validateSquad(next, byId, ds.rules, budget).valid) continue;
    const res = buildResult(next.map((id) => byId.get(id)!), proj, ds.rules, budget, prefs.formation);
    alts.push({
      playerId: cand.id,
      ep: proj.get(cand.id)!.ep,
      deltaEp: Math.round((res.expectedPoints - current.expectedPoints) * 100) / 100,
      deltaCostTenths: cand.costTenths - out.costTenths,
      remainingTenths: res.remainingTenths,
    });
  }
  alts.sort((a, b) => b.ep - a.ep || a.deltaCostTenths - b.deltaCostTenths || a.playerId - b.playerId);
  return { current, alternatives: alts.slice(0, limit) };
}
