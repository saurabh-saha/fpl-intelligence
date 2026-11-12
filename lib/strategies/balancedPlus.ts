// eslint-disable-next-line @typescript-eslint/no-require-imports
import solver from "javascript-lp-solver";
import { shrunkRate, XG_WEIGHT } from "../analytics/expectedPoints";
import type { Dataset, Player, Pos, Projection, Rules } from "../fpl/types";
import { POSITIONS } from "../fpl/types";
import { validateLineup, validateSquad } from "../optimizer/validation";
import type { Horizon } from "../season/horizon";

/**
 * "Balanced Plus": a fourth strategy that sits NEXT TO Balanced / Safe / Aggressive.
 * It reuses the projection engine and horizon but has its own value function and solver, so the existing
 * optimiser is untouched.
 */
export const BALANCED_PLUS = {
  name: "Balanced Plus",
  /** at most this many players from one club in the STARTING XI */
  maxPerClubXI: 2,
  /** XI membership bar (GW projection): secure starter with real minutes */
  xiMinStartProb: 0.75,
  xiMinExpMinutes: 60,
  xiMinAvailability: 0.9,
  /** bench outfield players must be genuine rotation options; any squad member must be reasonably fit */
  benchMinStartProb: 0.5,
  minAvailability: 0.75,
  /** bench counts for this share of a starter's value (Balanced uses 0.12) */
  benchWeight: 0.25,
  /** target total GW xPts of the four bench players; relaxed stepwise only if infeasible */
  benchTargets: [12, 11, 10, 9, 8, 6, 0],
  /** captain-vice must come from different clubs and the vice must be a secure starter */
  viceMinStartProb: 0.85,
  viceMinAvailability: 0.9,
} as const;

/**
 * Ablation switches for sensitivity analysis. The DEFAULTS reproduce the shipped strategy exactly;
 * nothing here is used by the app, only by the backtest to measure what each ingredient contributes.
 */
export interface BpOptions {
  /** minutes-security multiplier (default true) */
  security?: boolean;
  /** remove the recent-form tilt from the objective (default true) */
  removeForm?: boolean;
  /** rebuild goal/assist terms on xG/xA only (default true) */
  xgOnly?: boolean;
  /** use the raw model xPts as the objective value (default false) */
  raw?: boolean;
  /** XI club cap (default 2) */
  maxPerClubXI?: number;
}

export interface BpValue {
  id: number;
  /** discounted five-gameweek value after the Balanced Plus adjustments (what the solver maximises) */
  value: number;
  /** discounted five-gameweek expected points straight from the model, for comparison */
  rawEp5: number;
  /** this gameweek's model xPts (no adjustments) */
  ep0: number;
  /** this gameweek's Balanced Plus value */
  value0: number;
  /** points of rawEp5 removed because they came from the recent-form tilt */
  formRemoved5: number;
  /** attacking points moved to an xG/xA basis (negative = realised returns were flattering the player) */
  attackShift5: number;
  startProb: number;
  availability: number;
  expMinutes: number;
  xiEligible: boolean;
  benchEligible: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function isXiEligible(p: Player, pr: Projection): boolean {
  if (["u", "s", "n"].includes(p.status)) return false;
  return pr.startProb >= BALANCED_PLUS.xiMinStartProb && pr.expMinutes >= BALANCED_PLUS.xiMinExpMinutes && pr.availability >= BALANCED_PLUS.xiMinAvailability;
}
export function isSquadEligible(p: Player, pr: Projection): boolean {
  if (["u", "s", "n"].includes(p.status)) return false;
  if (pr.availability < BALANCED_PLUS.minAvailability) return false;
  if (isXiEligible(p, pr)) return true;
  if (p.pos === "GKP") return pr.availability >= 0.9; // a fit bench keeper
  return pr.startProb >= BALANCED_PLUS.benchMinStartProb; // a playable outfield sub
}

/**
 * Value of every player over the next five gameweeks, discounted with the horizon weights:
 *  - minutes security: ep scaled by 0.6 + 0.2*startProb + 0.2*min(1, expMinutes/80)
 *  - attacking return rebuilt from xG and xA only (realised goals/assists are not used), so lucky finishers
 *    and assist-heavy returns do not inflate the value
 *  - the recent-form tilt is removed entirely
 */
export function balancedPlusValues(ds: Dataset, hz: Horizon, opts: BpOptions = {}): Map<number, BpValue> {
  const out = new Map<number, BpValue>();
  const pri = hz.ctx.priors;
  const wsum = hz.weights.reduce((a, b) => a + b, 0);
  for (const p of ds.players) {
    const pr = pri[p.pos];
    const rGoalBlend = shrunkRate(XG_WEIGHT * p.xG + (1 - XG_WEIGHT) * p.goals, p.minutes, pr.g90);
    const rGoalXg = shrunkRate(p.xG, p.minutes, pr.g90);
    const rAstBlend = shrunkRate(XG_WEIGHT * p.xA + (1 - XG_WEIGHT) * p.assists, p.minutes, pr.a90);
    const rAstXg = shrunkRate(p.xA, p.minutes, pr.a90);
    const gRatio = rGoalBlend > 0 ? clamp(rGoalXg / rGoalBlend, 0.5, 1.5) : 1;
    const aRatio = rAstBlend > 0 ? clamp(rAstXg / rAstBlend, 0.5, 1.5) : 1;

    let value = 0;
    let raw = 0;
    let formRemoved = 0;
    let attackShift = 0;
    let value0 = 0;
    hz.proj.forEach((pm, k) => {
      const pj = pm.get(p.id)!;
      const c = pj.components;
      const adjGoals = opts.xgOnly === false ? c.goals : c.goals * gRatio;
      const adjAssists = opts.xgOnly === false ? c.assists : c.assists * aRatio;
      const formPart = opts.removeForm === false ? 0 : c.formAdj;
      const base = opts.raw ? pj.ep : Math.max(0, pj.ep - formPart - c.goals - c.assists + adjGoals + adjAssists);
      const security = opts.security === false ? 1 : 0.6 + 0.2 * pj.startProb + 0.2 * Math.min(1, pj.expMinutes / 80);
      const v = base * security;
      value += v * hz.weights[k];
      raw += pj.ep * hz.weights[k];
      formRemoved += (opts.raw ? 0 : formPart) * hz.weights[k];
      attackShift += (opts.raw ? 0 : adjGoals - c.goals + adjAssists - c.assists) * hz.weights[k];
      if (k === 0) value0 = v;
    });
    const p0 = hz.proj[0].get(p.id)!;
    out.set(p.id, {
      id: p.id,
      value: r2(value / wsum),
      rawEp5: r2(raw / wsum),
      ep0: p0.ep,
      value0: r2(value0),
      formRemoved5: r2(formRemoved / wsum),
      attackShift5: r2(attackShift / wsum),
      startProb: p0.startProb,
      availability: p0.availability,
      expMinutes: p0.expMinutes,
      xiEligible: isXiEligible(p, p0),
      benchEligible: isSquadEligible(p, p0),
    });
  }
  return out;
}

function prune(players: Player[], vals: Map<number, BpValue>): Player[] {
  const keep = new Set<number>();
  for (const pos of POSITIONS) {
    const ps = players.filter((p) => p.pos === pos && vals.get(p.id)!.benchEligible);
    const v = (p: Player) => vals.get(p.id)!.value;
    [...ps].sort((a, b) => v(b) - v(a)).slice(0, 30).forEach((p) => keep.add(p.id));
    [...ps].sort((a, b) => v(b) / b.costTenths - v(a) / a.costTenths).slice(0, 14).forEach((p) => keep.add(p.id));
    [...ps].sort((a, b) => a.costTenths - b.costTenths || v(b) - v(a)).slice(0, 8).forEach((p) => keep.add(p.id));
    const best = new Map<number, Player>();
    for (const p of [...ps].sort((a, b) => v(b) - v(a))) if (!best.has(p.costTenths)) best.set(p.costTenths, p);
    [...best.values()].forEach((p) => keep.add(p.id));
    // best XI-eligible player per position per club, so the club cap never starves a position
    const perClub = new Map<number, Player>();
    for (const p of [...ps].sort((a, b) => v(b) - v(a))) if (vals.get(p.id)!.xiEligible && !perClub.has(p.teamId)) perClub.set(p.teamId, p);
    [...perClub.values()].forEach((p) => keep.add(p.id));
  }
  return players.filter((p) => keep.has(p.id));
}

function solve(pool: Player[], vals: Map<number, BpValue>, rules: Rules, budgetTenths: number, benchMin: number, cap: number = BALANCED_PLUS.maxPerClubXI): { squad: number[]; xi: number[] } | null {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    budget: { max: budgetTenths },
    xiSize: { equal: rules.startingSize },
    xi_GKP: { equal: 1 },
  };
  for (const pos of POSITIONS) {
    constraints[`quota_${pos}`] = { equal: rules.quota[pos] };
    if (pos !== "GKP") constraints[`xi_${pos}`] = { min: rules.minPlay[pos], max: rules.maxPlay[pos] };
  }
  for (const t of new Set(pool.map((p) => p.teamId))) {
    constraints[`team_${t}`] = { max: rules.teamLimit };
    constraints[`xiteam_${t}`] = { max: cap };
  }
  if (benchMin > 0) constraints.bench = { min: benchMin };

  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, number> = {};
  const L = BALANCED_PLUS.benchWeight;
  for (const p of pool) {
    const v = vals.get(p.id)!;
    const eps = -1e-4 * p.costTenths - 1e-8 * p.id;
    variables[`x${p.id}`] = { obj: L * v.value + eps, budget: p.costTenths, [`quota_${p.pos}`]: 1, [`team_${p.teamId}`]: 1, [`link_${p.id}`]: -1, [`ub_x${p.id}`]: 1, bench: v.ep0 };
    ints[`x${p.id}`] = 1;
    constraints[`link_${p.id}`] = { max: 0 };
    constraints[`ub_x${p.id}`] = { max: 1 };
    if (v.xiEligible) {
      variables[`s${p.id}`] = { obj: (1 - L) * v.value, xiSize: 1, [`xi_${p.pos}`]: 1, [`xiteam_${p.teamId}`]: 1, [`link_${p.id}`]: 1, [`ub_s${p.id}`]: 1, bench: -v.ep0 };
      ints[`s${p.id}`] = 1;
      constraints[`ub_s${p.id}`] = { max: 1 };
    }
  }
  const res = solver.Solve({ optimize: "obj", opType: "max", constraints, variables, ints });
  if (!res.feasible) return null;
  return {
    squad: pool.filter((p) => (res[`x${p.id}`] ?? 0) > 0.5).map((p) => p.id),
    xi: pool.filter((p) => (res[`s${p.id}`] ?? 0) > 0.5).map((p) => p.id),
  };
}

export interface CaptaincyChoice {
  captain: number;
  vice: number;
  /** XI ranked by this gameweek's model xPts, the only thing captaincy looks at */
  ranking: { id: number; ep: number; startProb: number }[];
  viceRule: string;
}

/**
 * Captaincy is optimised on its own: raw model xPts for the gameweek, independent of the squad objective,
 * the minutes bars, the club cap and the form adjustments. The vice is the best remaining secure starter
 * from a DIFFERENT club, so one postponed match cannot lose both armbands.
 */
export function pickCaptaincyIndependently(xi: number[], hz: Horizon, byId: Map<number, Player>): CaptaincyChoice {
  const p0 = hz.proj[0];
  const ranking = [...xi]
    .map((id) => ({ id, ep: p0.get(id)!.ep, startProb: p0.get(id)!.startProb }))
    .sort((a, b) => b.ep - a.ep || b.startProb - a.startProb || a.id - b.id);
  const captain = ranking[0].id;
  const capClub = byId.get(captain)!.teamId;
  const rest = ranking.slice(1);
  const secure = (r: (typeof ranking)[number]) => r.startProb >= BALANCED_PLUS.viceMinStartProb && p0.get(r.id)!.availability >= BALANCED_PLUS.viceMinAvailability;
  let vice = rest.find((r) => secure(r) && byId.get(r.id)!.teamId !== capClub);
  let rule = "best remaining secure starter (start >= 85%) from a different club to the captain";
  if (!vice) { vice = rest.find(secure); rule = "best remaining secure starter (no secure option from another club)"; }
  if (!vice) { vice = rest[0]; rule = "best remaining player (no secure starter available)"; }
  return { captain, vice: vice.id, ranking: ranking.slice(0, 5), viceRule: rule };
}

export interface BalancedPlusResult {
  squad: number[];
  starting: number[];
  bench: number[];
  formation: string;
  captain: number;
  viceCaptain: number;
  captaincy: CaptaincyChoice;
  totalCostTenths: number;
  remainingTenths: number;
  /** GW xPts of the starting XI plus the captain's extra points */
  expectedPoints: number;
  benchEp: number;
  benchTargetMet: number;
  values: Map<number, BpValue>;
}

export class BalancedPlusError extends Error {}

export function optimizeBalancedPlus(ds: Dataset, hz: Horizon, opts: BpOptions = {}): BalancedPlusResult {
  const rules = ds.rules;
  const budget = rules.budgetTenths; // same £100m as the other strategies
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const cap = opts.maxPerClubXI ?? BALANCED_PLUS.maxPerClubXI;
  const values = balancedPlusValues(ds, hz, opts);
  const pool = prune(ds.players.filter((p) => values.get(p.id)!.benchEligible), values);

  let sol: ReturnType<typeof solve> = null;
  let target = 0;
  for (const t of BALANCED_PLUS.benchTargets) {
    sol = solve(pool, values, rules, budget, t, cap);
    if (sol) { target = t; break; }
  }
  if (!sol || sol.squad.length !== rules.squadSize || sol.xi.length !== rules.startingSize) throw new BalancedPlusError("No squad satisfies the Balanced Plus rules.");

  const val = (id: number) => values.get(id)!.value;
  const posOf = (id: number) => byId.get(id)!.pos;
  const order: Record<Pos, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const starting = [...sol.xi].sort((a, b) => order[posOf(a)] - order[posOf(b)] || val(b) - val(a) || a - b);
  const benchSet = sol.squad.filter((id) => !sol.xi.includes(id));
  const bench = [...benchSet.filter((id) => posOf(id) === "GKP"), ...benchSet.filter((id) => posOf(id) !== "GKP").sort((a, b) => val(b) - val(a) || a - b)];
  const cnt = (pos: Pos) => starting.filter((id) => posOf(id) === pos).length;
  const formation = `${cnt("DEF")}-${cnt("MID")}-${cnt("FWD")}`;
  const captaincy = pickCaptaincyIndependently(starting, hz, byId);

  // independent re-validation of every rule, never trust the solver
  const sv = validateSquad(sol.squad, byId, rules, budget);
  if (!sv.valid) throw new BalancedPlusError(`Invalid squad: ${sv.errors.join(" ")}`);
  const lv = validateLineup({ starting, bench, formation, captain: captaincy.captain, viceCaptain: captaincy.vice }, sol.squad, byId, rules);
  if (!lv.valid) throw new BalancedPlusError(`Invalid lineup: ${lv.errors.join(" ")}`);
  const perClub = new Map<number, number>();
  starting.forEach((id) => perClub.set(byId.get(id)!.teamId, (perClub.get(byId.get(id)!.teamId) ?? 0) + 1));
  if ([...perClub.values()].some((n) => n > cap)) throw new BalancedPlusError(`Starting XI breaks the ${cap}-per-club rule.`);

  const total = sol.squad.reduce((s, id) => s + byId.get(id)!.costTenths, 0);
  const ep0 = (id: number) => values.get(id)!.ep0;
  return {
    squad: [...starting, ...bench],
    starting,
    bench,
    formation,
    captain: captaincy.captain,
    viceCaptain: captaincy.vice,
    captaincy,
    totalCostTenths: total,
    remainingTenths: budget - total,
    expectedPoints: r2(starting.reduce((s, id) => s + ep0(id), 0) + ep0(captaincy.captain)),
    benchEp: r2(bench.reduce((s, id) => s + ep0(id), 0)),
    benchTargetMet: target,
    values,
  };
}


export interface BpLineup {
  starting: number[];
  bench: number[];
  formation: string;
  captain: number;
  vice: number;
  /** how strict the lineup rules could be kept for this squad */
  relaxed: "none" | "eligibility" | "eligibility+club-cap";
}

/**
 * Balanced Plus lineup rule applied to an ALREADY OWNED squad (used by the backtest when a squad is held for several
 * gameweeks): best XI by Balanced Plus value with the XI club cap and the secure-starter bars; if the squad cannot
 * satisfy them, the bars are relaxed in a fixed order (eligibility first, then the club cap). Captaincy stays independent.
 */
export function bestLineupBalancedPlus(ds: Dataset, hz: Horizon, squadIds: number[], opts: BpOptions = {}, valuesIn?: Map<number, BpValue>): BpLineup {
  const rules = ds.rules;
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const values = valuesIn ?? balancedPlusValues(ds, hz, opts);
  const cap = opts.maxPerClubXI ?? BALANCED_PLUS.maxPerClubXI;
  const squad = squadIds.map((id) => byId.get(id) as Player);

  const attempt = (needEligible: boolean, clubCap: number): number[] | null => {
    const constraints: Record<string, { min?: number; max?: number; equal?: number }> = { xiSize: { equal: rules.startingSize }, xi_GKP: { equal: 1 } };
    for (const pos of POSITIONS) if (pos !== "GKP") constraints[`xi_${pos}`] = { min: rules.minPlay[pos], max: rules.maxPlay[pos] };
    for (const t of new Set(squad.map((p) => p.teamId))) constraints[`xiteam_${t}`] = { max: clubCap };
    const variables: Record<string, Record<string, number>> = {};
    const ints: Record<string, number> = {};
    for (const p of squad) {
      const v = values.get(p.id) as BpValue;
      if (needEligible && !v.xiEligible) continue;
      variables[`s${p.id}`] = { obj: v.value - 1e-8 * p.id, xiSize: 1, [`xi_${p.pos}`]: 1, [`xiteam_${p.teamId}`]: 1, [`ub_s${p.id}`]: 1 };
      ints[`s${p.id}`] = 1;
      constraints[`ub_s${p.id}`] = { max: 1 };
    }
    if (Object.keys(variables).length < rules.startingSize) return null;
    const res = solver.Solve({ optimize: "obj", opType: "max", constraints, variables, ints });
    if (!res.feasible) return null;
    const xi = squad.filter((p) => (res[`s${p.id}`] ?? 0) > 0.5).map((p) => p.id);
    return xi.length === rules.startingSize ? xi : null;
  };

  let relaxed: BpLineup["relaxed"] = "none";
  let xi = attempt(true, cap);
  if (!xi) { relaxed = "eligibility"; xi = attempt(false, cap); }
  if (!xi) { relaxed = "eligibility+club-cap"; xi = attempt(false, rules.startingSize); }
  if (!xi) throw new BalancedPlusError("No legal lineup for this squad.");

  const val = (id: number) => (values.get(id) as BpValue).value;
  const order: Record<Pos, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const posOf = (id: number) => (byId.get(id) as Player).pos;
  const starting = [...xi].sort((a, b) => order[posOf(a)] - order[posOf(b)] || val(b) - val(a) || a - b);
  const rest = squadIds.filter((id) => !xi!.includes(id));
  const bench = [...rest.filter((id) => posOf(id) === "GKP"), ...rest.filter((id) => posOf(id) !== "GKP").sort((a, b) => val(b) - val(a) || a - b)];
  const cnt = (pos: Pos) => starting.filter((id) => posOf(id) === pos).length;
  const cap2 = pickCaptaincyIndependently(starting, hz, byId);
  return { starting, bench, formation: `${cnt("DEF")}-${cnt("MID")}-${cnt("FWD")}`, captain: cap2.captain, vice: cap2.vice, relaxed };
}
