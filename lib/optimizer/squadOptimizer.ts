// eslint-disable-next-line @typescript-eslint/no-require-imports
import solver from "javascript-lp-solver";
import { POSITIONS, type Dataset, type Player, type Pos, type Preferences, type Projection, type SquadResult } from "../fpl/types";
import { buildResult } from "./formationOptimizer";
import { parseFormation, validateSquad } from "./validation";

export class OptimizerError extends Error {}

/** Bench players are worth a fraction of a starter: they cover rotation and injuries. */
export const BENCH_WEIGHT = 0.12;

/** Players the optimiser may pick. Unavailable players are never recommended. */
export function eligible(p: Player, proj: Projection, prefs: Preferences): boolean {
  if (["u", "s", "n"].includes(p.status)) return false;
  if (proj.availability <= 0) return false;
  if (prefs.maxOwnership != null && p.ownership > prefs.maxOwnership) return false;
  return true;
}

/** Shrink the candidate pool so the ILP stays fast without removing any plausible optimum. */
function prunePool(players: Player[], proj: Map<number, Projection>, rules: Dataset["rules"]): Player[] {
  const keep = new Set<number>();
  for (const pos of POSITIONS) {
    const ps = players.filter((p) => p.pos === pos);
    const byScore = [...ps].sort((a, b) => proj.get(b.id)!.score - proj.get(a.id)!.score);
    const byValue = [...ps].sort(
      (a, b) => proj.get(b.id)!.score / a.costTenths - proj.get(a.id)!.score / b.costTenths || 0,
    );
    const byCheap = [...ps].sort((a, b) => a.costTenths - b.costTenths || proj.get(b.id)!.score - proj.get(a.id)!.score);
    byScore.slice(0, 26).forEach((p) => keep.add(p.id));
    // value-for-money picks, and cheap enablers (best score within each price point)
    [...ps]
      .sort((a, b) => proj.get(b.id)!.score / b.costTenths - proj.get(a.id)!.score / a.costTenths)
      .slice(0, 16)
      .forEach((p) => keep.add(p.id));
    byCheap.slice(0, 6).forEach((p) => keep.add(p.id));
    const bestPerPrice = new Map<number, Player>();
    for (const p of byScore) if (!bestPerPrice.has(p.costTenths)) bestPerPrice.set(p.costTenths, p);
    [...bestPerPrice.values()].forEach((p) => keep.add(p.id));
    void byValue;
  }
  void rules;
  return players.filter((p) => keep.has(p.id));
}

function solveIlp(
  pool: Player[],
  proj: Map<number, Projection>,
  rules: Dataset["rules"],
  budgetTenths: number,
  formation: [number, number, number] | null,
): number[] | null {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    budget: { max: budgetTenths },
    xiSize: { equal: rules.startingSize },
  };
  for (const pos of POSITIONS) {
    constraints[`quota_${pos}`] = { equal: rules.quota[pos] };
    if (pos === "GKP") {
      constraints[`xi_${pos}`] = { equal: 1 };
    } else if (formation) {
      constraints[`xi_${pos}`] = { equal: formation[POSITIONS.indexOf(pos) - 1] };
    } else {
      constraints[`xi_${pos}`] = { min: rules.minPlay[pos], max: rules.maxPlay[pos] };
    }
  }
  for (const t of new Set(pool.map((p) => p.teamId))) constraints[`team_${t}`] = { max: rules.teamLimit };

  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, number> = {};
  for (const p of pool) {
    const score = proj.get(p.id)!.score;
    // tiny deterministic tie-breakers: prefer cheaper, then lower id
    const eps = -1e-4 * p.costTenths - 1e-8 * p.id;
    const x: Record<string, number> = {
      obj: BENCH_WEIGHT * score + eps,
      budget: p.costTenths,
      [`quota_${p.pos}`]: 1,
      [`team_${p.teamId}`]: 1,
      [`link_${p.id}`]: -1,
      [`ub_x${p.id}`]: 1,
    };
    const s: Record<string, number> = {
      obj: (1 - BENCH_WEIGHT) * score,
      xiSize: 1,
      [`xi_${p.pos}`]: 1,
      [`link_${p.id}`]: 1,
      [`ub_s${p.id}`]: 1,
    };
    variables[`x${p.id}`] = x;
    variables[`s${p.id}`] = s;
    ints[`x${p.id}`] = 1;
    ints[`s${p.id}`] = 1;
    constraints[`link_${p.id}`] = { max: 0 };
    constraints[`ub_x${p.id}`] = { max: 1 };
    constraints[`ub_s${p.id}`] = { max: 1 };
  }

  const result = solver.Solve({ optimize: "obj", opType: "max", constraints, variables, ints });
  if (!result.feasible) return null;
  const chosen: number[] = [];
  for (const p of pool) if ((result[`x${p.id}`] ?? 0) > 0.5) chosen.push(p.id);
  return chosen;
}

/** Greedy fallback so a solver failure can never leave the user without a valid squad. */
function greedy(pool: Player[], proj: Map<number, Projection>, rules: Dataset["rules"], budgetTenths: number): number[] | null {
  const chosen: Player[] = [];
  const need: Record<Pos, number> = { ...rules.quota };
  const perTeam = new Map<number, number>();
  const cheapest = (pos: Pos) =>
    pool.filter((p) => p.pos === pos && !chosen.includes(p)).map((p) => p.costTenths).sort((a, b) => a - b);
  let spent = 0;
  const order = [...pool].sort((a, b) => proj.get(b.id)!.score - proj.get(a.id)!.score);
  for (const p of order) {
    if (need[p.pos] === 0 || (perTeam.get(p.teamId) ?? 0) >= rules.teamLimit) continue;
    // reserve enough for the cheapest completion of all remaining slots
    const remaining: Record<Pos, number> = { ...need, [p.pos]: need[p.pos] - 1 };
    chosen.push(p);
    let reserve = 0;
    for (const pos of POSITIONS) reserve += cheapest(pos).slice(0, remaining[pos]).reduce((s, c) => s + c, 0);
    chosen.pop();
    if (spent + p.costTenths + reserve > budgetTenths) continue;
    chosen.push(p);
    need[p.pos]--;
    spent += p.costTenths;
    perTeam.set(p.teamId, (perTeam.get(p.teamId) ?? 0) + 1);
  }
  return chosen.length === rules.squadSize ? chosen.map((p) => p.id) : null;
}

export interface OptimizeOutput {
  result: SquadResult;
  budgetTenths: number;
  method: "ilp" | "greedy-fallback";
}

/**
 * Deterministic squad optimiser. Maximises (starting XI score + small bench weight) subject to
 * FPL's squad rules via integer linear programming, then derives formation/captain/bench from the squad.
 */
export function optimizeSquad(ds: Dataset, proj: Map<number, Projection>, prefs: Preferences): OptimizeOutput {
  const { rules } = ds;
  const budgetTenths = prefs.overCap && prefs.budgetTenths ? prefs.budgetTenths : Math.min(prefs.budgetTenths ?? rules.budgetTenths, rules.budgetTenths);
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const formation = prefs.formation ? parseFormation(prefs.formation) : null;
  if (prefs.formation && !formation) throw new OptimizerError(`Invalid formation "${prefs.formation}".`);

  const candidates = ds.players.filter((p) => eligible(p, proj.get(p.id)!, prefs));
  const pool = prunePool(candidates, proj, rules);

  let ids = solveIlp(pool, proj, rules, budgetTenths, formation);
  let method: OptimizeOutput["method"] = "ilp";
  if (ids && !validateSquad(ids, byId, rules, budgetTenths).valid) ids = null;
  if (!ids) {
    ids = greedy(pool, proj, rules, budgetTenths);
    method = "greedy-fallback";
  }
  if (!ids) throw new OptimizerError("No valid squad satisfies these constraints. Try a higher budget or relax the ownership cap.");
  const check = validateSquad(ids, byId, rules, budgetTenths);
  if (!check.valid) throw new OptimizerError(`Optimiser produced an invalid squad: ${check.errors.join(" ")}`);

  const squad = ids.map((id) => byId.get(id)!);
  return { result: buildResult(squad, proj, rules, budgetTenths, prefs.formation), budgetTenths, method };
}
