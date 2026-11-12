import { projectAll } from "@/lib/analytics/playerScoring";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";
import type { Dataset, Projection } from "@/lib/fpl/types";
import type { SeasonSquad, SeasonState } from "@/lib/season/types";
import { NEXT_GW, sampleDataset } from "./helpers";

export const ds: Dataset = sampleDataset();
export const by = new Map(ds.players.map((p) => [p.id, p]));

export function squadFrom(ids: number[], opts: Partial<SeasonSquad> = {}): SeasonSquad {
  const spent = ids.reduce((s, id) => s + by.get(id)!.costTenths, 0);
  return { gw: NEXT_GW, holdings: ids.map((id) => ({ id, buyTenths: by.get(id)!.costTenths })), bankTenths: 1000 - spent, freeTransfers: 1, chipsUsed: [], ...opts };
}

/** A decent-but-not-optimal squad: optimised on recent form, leaving transfer upside. */
export function mediocreSquad(opts: Partial<SeasonSquad> = {}): SeasonSquad {
  const { byId } = projectAll(ds, NEXT_GW);
  const form = new Map<number, Projection>(byId);
  for (const p of ds.players) form.set(p.id, { ...byId.get(p.id)!, ep: p.form, score: p.form });
  const r = optimizeSquad(ds, form, { mode: "balanced", budgetTenths: 980 }).result;
  return squadFrom(r.squad, opts);
}

export function optimalSquad(opts: Partial<SeasonSquad> = {}): SeasonSquad {
  const { byId } = projectAll(ds, NEXT_GW);
  return squadFrom(optimizeSquad(ds, byId, { mode: "balanced" }).result.squad, opts);
}

export const stateOf = (actual: SeasonSquad, plans: SeasonState["plans"] = {}): SeasonState => ({
  version: 1, source: "manual", actual, plans, snapshots: [], recs: [], actualHistory: [], warnings: [], updatedAt: "",
});

/** Same-position players not in the squad, cheapest first. */
export function swapCandidates(squad: SeasonSquad, outId: number) {
  const pos = by.get(outId)!.pos;
  const owned = new Set(squad.holdings.map((h) => h.id));
  return ds.players.filter((p) => p.pos === pos && !owned.has(p.id) && p.status === "a").sort((a, b) => a.costTenths - b.costTenths);
}
