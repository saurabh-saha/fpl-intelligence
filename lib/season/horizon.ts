import type { Dataset, Player, Projection } from "../fpl/types";
import { projectPlayer, type ModelContext } from "../analytics/expectedPoints";
import { projectAll } from "../analytics/playerScoring";
import { bestLineup, lineupExpectedPoints } from "../optimizer/formationOptimizer";

/** Discount applied to later gameweeks: a transfer's benefit is less certain the further out it is. */
export const HORIZON_WEIGHTS = [1, 0.9, 0.8, 0.7, 0.6];
export const HORIZON_LEN = HORIZON_WEIGHTS.length;

export interface Horizon {
  gws: number[];
  weights: number[];
  /** per-gameweek projections; `score` == `ep` so lineups are chosen on pure expected points */
  proj: Map<number, Projection>[];
  /** projections for the first gameweek WITH explanations/warnings (for display) */
  display: Map<number, Projection>;
  ctx: ModelContext;
}

export function buildHorizon(ds: Dataset, gw: number, len = HORIZON_LEN): Horizon {
  const last = ds.events[ds.events.length - 1]?.id ?? gw;
  const { ctx, byId } = projectAll(ds, gw, { mode: "balanced" });
  const gws: number[] = [];
  for (let g = gw; g < gw + len && g <= last; g++) gws.push(g);
  const proj: Map<number, Projection>[] = gws.map((g) => {
    const m = new Map<number, Projection>();
    for (const p of ds.players) {
      const pr = g === gw ? byId.get(p.id)! : projectPlayer(p, ctx, g);
      m.set(p.id, { ...pr, score: pr.ep });
    }
    return m;
  });
  return { gws, weights: HORIZON_WEIGHTS.slice(0, gws.length), proj, display: byId, ctx };
}

export interface SquadValue {
  /** discounted sum of best-XI expected points over the horizon */
  weighted: number;
  perGw: number[];
}

/** Value of a 15-man squad: best XI + captain re-chosen each gameweek, discounted over the horizon. */
export function squadValue(players: Player[], hz: Horizon, ds: Dataset): SquadValue {
  const perGw = hz.proj.map((pm) => lineupExpectedPoints(bestLineup(players, pm, ds.rules), pm));
  return { weighted: perGw.reduce((s, v, k) => s + v * hz.weights[k], 0), perGw };
}

/** Discounted expected points of a single player across the horizon (used to rank candidates). */
export function playerHorizonEp(id: number, hz: Horizon): number {
  return hz.proj.reduce((s, pm, k) => s + (pm.get(id)?.ep ?? 0) * hz.weights[k], 0);
}
