import type { Dataset } from "../fpl/types";
import { squadValue, playerHorizonEp, type Horizon } from "./horizon";
import { applyPlan, byIdMap, editPlan } from "./squad";
import type { GwPlan, SeasonSquad } from "./types";

export interface SeasonAlternative {
  playerId: number;
  /** this gameweek's expected points of the candidate */
  ep: number;
  horizonEp: number;
  sellTenths: number;
  buyTenths: number;
  /** squad change if swapped in (captain included) */
  deltaEpGw: number;
  deltaHorizon: number;
  /** extra points deducted because this swap adds a transfer beyond the free allowance */
  extraHit: number;
  net: number;
  bankAfterTenths: number;
}

/**
 * Legal replacements for `outId` within the PROPOSED squad (base + plan). Each candidate is checked by the
 * same deterministic `applyPlan` used everywhere (selling prices, bank, club limit, position, chips).
 */
export function seasonAlternatives(ds: Dataset, base: SeasonSquad, plan: GwPlan | undefined, gw: number, outId: number, hz: Horizon, limit = 80) {
  const by = byIdMap(ds);
  const cur = applyPlan(base, plan, ds, gw);
  const baseIds = base.holdings.map((h) => h.id);
  const curIds = plan?.chip === "freehit" ? (plan.freeHitIds ?? cur.holdings.map((h) => h.id)) : cur.holdings.map((h) => h.id);
  const curPlayers = curIds.map((id) => by.get(id)!);
  const curValue = squadValue(curPlayers, hz, ds);
  const outP = by.get(outId);
  if (!outP || !curIds.includes(outId)) throw new Error("Player is not in the squad.");

  const out: SeasonAlternative[] = [];
  for (const cand of ds.players) {
    if (cand.pos !== outP.pos || curIds.includes(cand.id) || cand.status === "u" || cand.status === "n") continue;
    let ids: number[];
    let hit = 0;
    let bank: number;
    let sell = 0;
    if (plan?.chip === "freehit") {
      ids = curIds.map((id) => (id === outId ? cand.id : id));
      const total = cur.freeHitBudgetTenths ?? 0;
      const cost = ids.reduce((s, id) => s + by.get(id)!.costTenths, 0);
      const clubs = new Map<number, number>();
      ids.forEach((id) => clubs.set(by.get(id)!.teamId, (clubs.get(by.get(id)!.teamId) ?? 0) + 1));
      if (cost > total || [...clubs.values()].some((n) => n > ds.rules.teamLimit)) continue;
      bank = total - cost;
      sell = outP.costTenths;
    } else {
      let next: GwPlan;
      try {
        next = editPlan(plan, baseIds, outId, cand.id);
      } catch {
        continue;
      }
      const r = applyPlan(base, next, ds, gw);
      if (!r.valid) continue;
      ids = r.holdings.map((h) => h.id);
      hit = r.hitCost - cur.hitCost;
      bank = r.bankTenths;
      const rec = r.transfers.find((t) => t.in === cand.id) ?? r.transfers[0];
      sell = rec?.sellTenths ?? outP.costTenths;
    }
    const v = squadValue(ids.map((id) => by.get(id)!), hz, ds);
    out.push({
      playerId: cand.id,
      ep: hz.proj[0].get(cand.id)!.ep,
      horizonEp: Math.round(playerHorizonEp(cand.id, hz) * 100) / 100,
      sellTenths: sell,
      buyTenths: cand.costTenths,
      deltaEpGw: Math.round((v.perGw[0] - curValue.perGw[0]) * 100) / 100,
      deltaHorizon: Math.round((v.weighted - curValue.weighted) * 100) / 100,
      extraHit: hit,
      net: Math.round((v.weighted - curValue.weighted - hit) * 100) / 100,
      bankAfterTenths: bank,
    });
  }
  out.sort((a, b) => b.ep - a.ep || a.playerId - b.playerId);
  return out.slice(0, limit);
}
