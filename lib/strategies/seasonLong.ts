// eslint-disable-next-line @typescript-eslint/no-require-imports
import solver from "javascript-lp-solver";
import { projectAll } from "../analytics/playerScoring";
import { buildModelContext, projectPlayer } from "../analytics/expectedPoints";
import { annotateProjections, applyNewsToDataset, type NewsOverlay } from "../news/overlay";
import type { Dataset, Player, Pos, Projection, Rules } from "../fpl/types";
import { POSITIONS } from "../fpl/types";
import { bestLineup, lineupExpectedPoints } from "../optimizer/formationOptimizer";
import { parseFormation, validateLineup, validateSquad } from "../optimizer/validation";
import { squadValue, type Horizon } from "../season/horizon";
import { analyseTransfers, type TransferAnalysis, type TransferDetail } from "../season/transfers";
import type { SeasonSquad } from "../season/types";
import { pickCaptaincyIndependently } from "./balancedPlus";

/**
 * "Season Long": builds a squad for the REST of the season instead of the next few gameweeks.
 * It is a separate strategy: it reuses the shared projection engine, the Horizon shape and the transfer engine, and
 * changes none of them. Balanced, Safe, Differential (aggressive) and Balanced Plus are untouched.
 */
export const SEASON_LONG = {
  name: "Season Long",
  /** per-gameweek discount on projected points: near-term projections count more than distant ones */
  discount: 0.93,
  /** fixture-strength trust: weight rho^j on the specific opponent at lead j, the rest on the player's own average fixture.
   *  Calibrated on the development season: blending distant opponents toward the average did not help, so the real fixture list is trusted fully (1). */
  fixtureTrust: 1,
  /** extra availability haircut on FIT players at distance (new injuries/rotation not yet visible). Calibrated on the development season to
   *  make long-lead projections unbiased against actual points (0.12). */
  futureAbsence: 0.12,
  /** recovery time constants (gameweeks) of a player who is currently doubtful / injured / suspended */
  recoveryTau: { a: 2, d: 3, i: 8, s: 2 } as Record<string, number>,
  /** share of a starter's value credited to a bench player (the other strategies use 12-25%) */
  benchWeight: 0.3,
  /** core-XI membership: secure starters who are fit now */
  xiMinStartProb: 0.5,
  xiMinAvailability: 0.5,
  /** squad membership: playable now */
  benchMinStartProb: 0.3,
  minAvailability: 0.25,
} as const;

export type SlParams = {
  discount: number;
  fixtureTrust: number;
  futureAbsence: number;
  recoveryTau: Record<string, number>;
  benchWeight: number;
  xiMinStartProb: number;
  xiMinAvailability: number;
  benchMinStartProb: number;
  minAvailability: number;
};

export const SEASON_LONG_LIMITATIONS: string[] = [
  "Long-range projections are estimates: team strength is the season-to-date figure (shrunk toward the league average), not a forecast, and the opponent effect is blended toward each player's own average fixture at distance.",
  "No double or blank gameweeks are scheduled yet, so they are not anticipated; the horizon assumes one fixture per club per gameweek as currently published.",
  "FPL gives no injury return dates ('Unknown return date'); recovery of injured players follows an assumed time constant, not information.",
  "Future price changes, chips and a manager's own future transfers are not modelled; the discount partly stands in for the ability to replace players later.",
  "Distant gameweeks carry far more uncertainty than the next one; do not read remaining-season xPts as a forecast of points.",
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class SeasonLongError extends Error {}

/* ------------------------------------------------------------------ availability */

/**
 * Probability the player is available j gameweeks from now. Anchored on FPL's own status and chance-of-playing for
 * j = 0 and recovering exponentially toward (1 - futureAbsence). Unavailable / not-in-squad players stay at 0.
 */
export function availabilityTrajectory(p: Player, j: number, params: Pick<SlParams, "futureAbsence" | "recoveryTau"> = SEASON_LONG): number {
  if (p.status === "u" || p.status === "n") return 0;
  const target = 1 - params.futureAbsence;
  let a0: number;
  if (p.chanceNext !== null) a0 = clamp(p.chanceNext / 100, 0, 1);
  else a0 = p.status === "a" ? 1 : p.status === "d" ? 0.5 : p.status === "s" ? 0 : 0.25;
  if (p.status === "s") a0 = 0;
  const tau = params.recoveryTau[p.status] ?? params.recoveryTau.a;
  if (a0 >= target && j === 0) return clamp(a0, 0, 1);
  return clamp(target - (target - a0) * Math.exp(-j / tau), 0, 1);
}

/* ------------------------------------------------------------------ horizon */

export interface SeasonHorizon extends Horizon {
  endGw: number;
  params: SlParams;
  /** sum of the discount weights (scale for decision thresholds) */
  discountSum: number;
}

/**
 * Remaining-season projections. For every player and gameweek j (0 = the selected gameweek):
 *   ep_j = a_j * n_j * ( f_j * epPerFixture_j + (1 - f_j) * epPerFixtureAverage )
 * with epPerFixture from the shared engine for a player assumed FIT, a_j the availability trajectory and f_j = rho^j.
 * Weights are discount^j (so the horizon is genuinely long, unlike HORIZON_WEIGHTS which only has five entries).
 */
export function buildSeasonHorizon(ds: Dataset, gw: number, opts: { endGw?: number; params?: Partial<SlParams>; news?: NewsOverlay | null } = {}): SeasonHorizon {
  const params: SlParams = { ...SEASON_LONG, recoveryTau: { ...SEASON_LONG.recoveryTau }, ...opts.params } as SlParams;
  const last = ds.events[ds.events.length - 1]?.id ?? gw;
  const endGw = clamp(Math.round(opts.endGw ?? last), gw, last);
  // News (optional): first-gameweek display projections come from the news-patched dataset; each later gameweek's
  // availability is scaled by the news-adjusted / base minutes ratio from the deterministic availability engine.
  const news = opts.news ?? null;
  const { ds: dsN, impacts } = applyNewsToDataset(ds, gw, news);
  const proj0 = projectAll(dsN, gw, { mode: "balanced" });
  annotateProjections(proj0.byId, impacts);
  const ctx = news && dsN !== ds ? buildModelContext(ds, gw) : proj0.ctx;
  const byId = proj0.byId;
  const gws: number[] = [];
  for (let g = gw; g <= endGw; g++) gws.push(g);
  const weights = gws.map((_, j) => Math.pow(params.discount, j));
  const proj: Map<number, Projection>[] = gws.map(() => new Map());

  for (const p of ds.players) {
    const fit: Player = { ...p, status: "a", chanceNext: null };
    const base = gws.map((g) => projectPlayer(fit, ctx, g));
    const perFixture = base.map((b) => (b.fixtures.length ? b.ep / b.fixtures.length : NaN));
    const valid = perFixture.filter((v) => Number.isFinite(v));
    const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    base.forEach((b, j) => {
      const n = b.fixtures.length;
      const f = Math.pow(params.fixtureTrust, j);
      let a = availabilityTrajectory(p, j, params);
      const adj = news?.adjust(p, ds, ctx, gws[j]);
      if (adj) a = adj.baseExpectedMinutes > 0 ? Math.min(1, (a * adj.adjustedExpectedMinutes) / adj.baseExpectedMinutes) : Math.min(1, adj.adjustedAvailability * (1 - params.futureAbsence));
      const ep = n === 0 ? 0 : a * n * (f * perFixture[j] + (1 - f) * avg);
      proj[j].set(p.id, { ...b, ep: r2(ep), score: r2(ep), availability: r2(a), warnings: [], reasons: [] });
    });
  }
  return { gws, weights, proj, display: byId, ctx, endGw, params, discountSum: weights.reduce((a, b) => a + b, 0), news };
}

/* ------------------------------------------------------------------ values */

export interface SlValue {
  id: number;
  /** discounted rest-of-season xPts (what the optimiser maximises) */
  value: number;
  /** undiscounted rest-of-season xPts */
  rawSeason: number;
  /** next-gameweek xPts as displayed by every strategy (shared engine) */
  ep0: number;
  startProb: number;
  expMinutes: number;
  availability0: number;
  /** average availability over the horizon */
  availabilityAvg: number;
  restAvgPerGw: number;
  fdrNext8: number;
  fdrRest: number;
  fixtures: number;
}

const avgFdr = (hz: Horizon, id: number, from: number, to: number) => {
  const f = hz.proj.slice(from, to).flatMap((m) => m.get(id)!.fixtures);
  return f.length ? r2(f.reduce((a, x) => a + x.difficulty, 0) / f.length) : 0;
};

export function seasonValues(ds: Dataset, hz: SeasonHorizon): Map<number, SlValue> {
  const out = new Map<number, SlValue>();
  for (const p of ds.players) {
    let value = 0;
    let raw = 0;
    let av = 0;
    let fx = 0;
    hz.proj.forEach((m, j) => {
      const pj = m.get(p.id)!;
      value += pj.ep * hz.weights[j];
      raw += pj.ep;
      av += pj.availability;
      fx += pj.fixtures.length;
    });
    const d0 = hz.display.get(p.id)!;
    out.set(p.id, {
      id: p.id,
      value: r2(value),
      rawSeason: r2(raw),
      ep0: d0.ep,
      startProb: d0.startProb,
      expMinutes: d0.expMinutes,
      availability0: hz.proj[0].get(p.id)!.availability,
      availabilityAvg: r2(av / hz.gws.length),
      restAvgPerGw: r2(raw / hz.gws.length),
      fdrNext8: avgFdr(hz, p.id, 0, 8),
      fdrRest: avgFdr(hz, p.id, 8, hz.gws.length),
      fixtures: fx,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ optimiser */

export interface SlPrefs {
  budgetTenths?: number;
  formation?: string;
  maxOwnership?: number;
}

function prune(players: Player[], vals: Map<number, SlValue>): Player[] {
  const keep = new Set<number>();
  for (const pos of POSITIONS) {
    const ps = players.filter((p) => p.pos === pos);
    const v = (p: Player) => vals.get(p.id)!.value;
    [...ps].sort((a, b) => v(b) - v(a)).slice(0, 30).forEach((p) => keep.add(p.id));
    [...ps].sort((a, b) => v(b) / b.costTenths - v(a) / a.costTenths).slice(0, 14).forEach((p) => keep.add(p.id));
    [...ps].sort((a, b) => a.costTenths - b.costTenths || v(b) - v(a)).slice(0, 8).forEach((p) => keep.add(p.id));
    const best = new Map<number, Player>();
    for (const p of [...ps].sort((a, b) => v(b) - v(a))) if (!best.has(p.costTenths)) best.set(p.costTenths, p);
    [...best.values()].forEach((p) => keep.add(p.id));
  }
  return players.filter((p) => keep.has(p.id));
}

interface Level { xiStart: number; xiAvail: number; sqStart: number; sqAvail: number }

function solve(pool: Player[], vals: Map<number, SlValue>, rules: Rules, budget: number, formation: [number, number, number] | null, lv: Level, benchWeight: number) {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = { budget: { max: budget }, xiSize: { equal: rules.startingSize }, xi_GKP: { equal: 1 } };
  for (const pos of POSITIONS) {
    constraints[`quota_${pos}`] = { equal: rules.quota[pos] };
    if (pos === "GKP") continue;
    constraints[`xi_${pos}`] = formation ? { equal: formation[POSITIONS.indexOf(pos) - 1] } : { min: rules.minPlay[pos], max: rules.maxPlay[pos] };
  }
  for (const t of new Set(pool.map((p) => p.teamId))) constraints[`team_${t}`] = { max: rules.teamLimit };
  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, number> = {};
  for (const p of pool) {
    const v = vals.get(p.id)!;
    const sqOk = p.pos === "GKP" ? v.availability0 >= lv.sqAvail : v.availability0 >= lv.sqAvail && v.startProb >= lv.sqStart;
    if (!sqOk || ["u", "n"].includes(p.status)) continue;
    const eps = -1e-4 * p.costTenths - 1e-8 * p.id;
    variables[`x${p.id}`] = { obj: benchWeight * v.value + eps, budget: p.costTenths, [`quota_${p.pos}`]: 1, [`team_${p.teamId}`]: 1, [`link_${p.id}`]: -1, [`ub_x${p.id}`]: 1 };
    ints[`x${p.id}`] = 1;
    constraints[`link_${p.id}`] = { max: 0 };
    constraints[`ub_x${p.id}`] = { max: 1 };
    if (v.startProb >= lv.xiStart && v.availability0 >= lv.xiAvail) {
      variables[`s${p.id}`] = { obj: (1 - benchWeight) * v.value, xiSize: 1, [`xi_${p.pos}`]: 1, [`link_${p.id}`]: 1, [`ub_s${p.id}`]: 1 };
      ints[`s${p.id}`] = 1;
      constraints[`ub_s${p.id}`] = { max: 1 };
    }
  }
  const res = solver.Solve({ optimize: "obj", opType: "max", constraints, variables, ints });
  if (!res.feasible) return null;
  return {
    squad: pool.filter((p) => (res[`x${p.id}`] ?? 0) > 0.5).map((p) => p.id),
    core: pool.filter((p) => (res[`s${p.id}`] ?? 0) > 0.5).map((p) => p.id),
  };
}

export interface SlResult {
  squad: number[];
  starting: number[];
  bench: number[];
  formation: string;
  captain: number;
  viceCaptain: number;
  /** best XI by rest-of-season value (the "core"), which can differ from this week's XI */
  coreXI: number[];
  totalCostTenths: number;
  remainingTenths: number;
  /** this gameweek: starting XI + captain's extra points (displayed xPts, same basis as every strategy) */
  expectedPoints: number;
  values: Map<number, SlValue>;
  relaxed: number;
}

/** This gameweek's XI by the shared engine's xPts (the same projection every strategy displays), independent captaincy. */
export function seasonLongLineup(ds: Dataset, hz: Pick<Horizon, "display">, squadIds: number[], formation?: string) {
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const score = new Map([...hz.display].map(([id, pr]) => [id, { ...pr, score: pr.ep }]));
  const l = bestLineup(squadIds.map((id) => byId.get(id) as Player), score, ds.rules, formation);
  const cap = pickCaptaincyIndependently(l.starting, { proj: [hz.display] } as unknown as Horizon, byId);
  return { starting: l.starting, bench: l.bench, formation: l.formation, captain: cap.captain, vice: cap.vice };
}

export function optimizeSeasonLong(ds: Dataset, hz: SeasonHorizon, prefs: SlPrefs = {}, valuesIn?: Map<number, SlValue>): SlResult {
  const rules = ds.rules;
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const budget = Math.min(prefs.budgetTenths ?? rules.budgetTenths, rules.budgetTenths);
  const formation = prefs.formation ? parseFormation(prefs.formation) : null;
  if (prefs.formation && !formation) throw new SeasonLongError(`Invalid formation "${prefs.formation}".`);
  const P = hz.params;
  const vals = valuesIn ?? seasonValues(ds, hz);
  const candidates = ds.players.filter((p) => prefs.maxOwnership == null || p.ownership <= prefs.maxOwnership);
  const pool = prune(candidates, vals);

  const levels: Level[] = [
    { xiStart: P.xiMinStartProb, xiAvail: P.xiMinAvailability, sqStart: P.benchMinStartProb, sqAvail: P.minAvailability },
    { xiStart: 0.3, xiAvail: 0.25, sqStart: 0.15, sqAvail: 0.1 },
    { xiStart: 0, xiAvail: 0, sqStart: 0, sqAvail: 0 },
  ];
  let sol: ReturnType<typeof solve> = null;
  let relaxed = -1;
  for (let i = 0; i < levels.length && !sol; i++) {
    sol = solve(pool, vals, rules, budget, formation, levels[i], P.benchWeight);
    relaxed = i;
  }
  if (!sol || sol.squad.length !== rules.squadSize || sol.core.length !== rules.startingSize) throw new SeasonLongError("No squad satisfies these constraints. Try a higher budget, another formation or a looser ownership cap.");
  const sv = validateSquad(sol.squad, byId, rules, budget);
  if (!sv.valid) throw new SeasonLongError(`Invalid squad: ${sv.errors.join(" ")}`);

  const lineup = seasonLongLineup(ds, hz, sol.squad, prefs.formation);
  const lv = validateLineup({ starting: lineup.starting, bench: lineup.bench, formation: lineup.formation, captain: lineup.captain, viceCaptain: lineup.vice }, sol.squad, byId, rules);
  if (!lv.valid) throw new SeasonLongError(`Invalid lineup: ${lv.errors.join(" ")}`);
  const total = sol.squad.reduce((s, id) => s + (byId.get(id) as Player).costTenths, 0);
  const ep = (id: number) => (hz.display.get(id) as Projection).ep;
  return {
    squad: [...lineup.starting, ...lineup.bench],
    starting: lineup.starting,
    bench: lineup.bench,
    formation: lineup.formation,
    captain: lineup.captain,
    viceCaptain: lineup.vice,
    coreXI: sol.core,
    totalCostTenths: total,
    remainingTenths: budget - total,
    expectedPoints: r2(lineup.starting.reduce((a, id) => a + ep(id), 0) + ep(lineup.captain)),
    values: vals,
    relaxed,
  };
}

/* ------------------------------------------------------------------ details and explanations */

export interface SlRow {
  id: number;
  name: string;
  pos: Pos;
  club: string;
  priceM: number;
  role: "starting" | "bench";
  slot: number;
  isCaptain: boolean;
  isVice: boolean;
  /** next gameweek xPts (shared engine, comparable with every other strategy) */
  xptsNextGw: number;
  /** discounted rest-of-season xPts (the optimiser's value) */
  xptsRestOfSeasonDiscounted: number;
  /** undiscounted rest-of-season xPts (availability-adjusted) */
  xptsRestOfSeasonRaw: number;
  restAvgPerGw: number;
  startProb: number;
  expMinutes: number;
  availabilityNow: number;
  rankInPosition: number;
  inCoreXI: boolean;
  fdrNext8: number;
  fdrRest: number;
  reasons: string[];
  /** only for bench players */
  benchReason?: string;
}

export function describeSeasonLong(ds: Dataset, hz: SeasonHorizon, vals: Map<number, SlValue>, sel: { starting: number[]; bench: number[]; captain: number; vice: number; coreXI?: number[] }): SlRow[] {
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const club = (id: number) => ds.teams[(by.get(id) as Player).teamId]?.short ?? "?";
  const all = [...sel.starting, ...sel.bench];
  // rank by rest-of-season value among ALL players of the position
  const rank = new Map<number, number>();
  const size: Record<string, number> = {};
  for (const pos of POSITIONS) {
    const ps = ds.players.filter((p) => p.pos === pos && !["u", "n"].includes(p.status)).sort((a, b) => (vals.get(b.id) as SlValue).value - (vals.get(a.id) as SlValue).value);
    size[pos] = ps.length;
    ps.forEach((p, i) => rank.set(p.id, i + 1));
  }
  const score = new Map([...vals].map(([id, v]) => [id, { ...(hz.display.get(id) as Projection), score: v.value }]));
  const core = new Set(sel.coreXI ?? bestLineup(all.map((id) => by.get(id) as Player), score, ds.rules).starting);
  const startSet = new Set(sel.starting);
  const weakest = (pos: Pos, ids: number[]) => ids.filter((i) => (by.get(i) as Player).pos === pos).sort((a, b) => (vals.get(a) as SlValue).value - (vals.get(b) as SlValue).value)[0];

  return all.map((id) => {
    const p = by.get(id) as Player;
    const v = vals.get(id) as SlValue;
    const starting = startSet.has(id);
    const reasons: string[] = [];
    reasons.push(`Rest-of-season value ${v.value.toFixed(1)} discounted xPts (${v.rawSeason.toFixed(0)} undiscounted), #${rank.get(id)} of ${size[p.pos]} ${p.pos}s.`);
    reasons.push(v.startProb >= 0.85 ? `Secure starter: ${Math.round(v.startProb * 100)}% start probability, ~${v.expMinutes} expected minutes.` : `Rotation risk: ${Math.round(v.startProb * 100)}% start probability, ~${v.expMinutes} expected minutes.`);
    if (v.fixtures > 0) reasons.push(`Fixtures: average difficulty ${v.fdrNext8.toFixed(1)} over the next 8, ${v.fdrRest ? v.fdrRest.toFixed(1) : "n/a"} for the rest of the season.`);
    if (v.availability0 < 1) reasons.push(`Availability now ${Math.round(v.availability0 * 100)}%${p.news ? ` (${p.news})` : ""}; modelled to recover over time (average ${Math.round(v.availabilityAvg * 100)}% across the horizon). No return date is published.`);
    reasons.push(`£${p.cost.toFixed(1)}m: ${(v.rawSeason / p.cost).toFixed(1)} rest-of-season xPts per £m.`);
    let benchReason: string | undefined;
    if (starting) {
      reasons.unshift(core.has(id) ? "Core player: in the best XI by rest-of-season value." : `Starts this gameweek on this week's projection (${v.ep0.toFixed(2)} xPts) although ranked below the core on rest-of-season value.`);
    } else {
      const w = weakest(p.pos, sel.starting);
      const wv = w ? (vals.get(w) as SlValue) : undefined;
      if (p.pos === "GKP") {
        const gk = sel.starting.find((i) => (by.get(i) as Player).pos === "GKP");
        benchReason = `Substitute goalkeeper: ${gk ? `${(by.get(gk) as Player).webName} has the higher rest-of-season value (${(vals.get(gk) as SlValue).value.toFixed(1)} vs ${v.value.toFixed(1)})` : "second keeper"}; £${p.cost.toFixed(1)}m cover for injury or rotation.`;
      } else if (w && wv && w !== id && v.value >= wv.value) {
        // ranks level with or ahead of the weakest starter over the season, so the bench slot is about THIS week
        benchReason = `Benched this gameweek on the immediate projection (${v.ep0.toFixed(2)} xPts vs ${(by.get(w) as Player).webName} ${(hz.display.get(w) as Projection).ep.toFixed(2)}); over the season it ranks level or ahead (${v.value.toFixed(1)} vs ${wv.value.toFixed(1)} rest-of-season value), so it is the first call-up if ${(by.get(w) as Player).webName} is injured, suspended or rotated.`;
      } else {
        benchReason = `Bench cover: rest-of-season value ${v.value.toFixed(1)} is below the weakest ${p.pos} in the XI${w && wv ? ` (${(by.get(w) as Player).webName} ${wv.value.toFixed(1)}${(by.get(w) as Player).cost > p.cost ? `, £${((by.get(w) as Player).cost - p.cost).toFixed(1)}m dearer` : ""})` : ""}; ${Math.round(v.startProb * 100)}% start probability, so a playable replacement when a starter is injured, suspended or rotated.`;
      }
    }
    const slot = starting ? sel.starting.indexOf(id) + 1 : sel.bench.indexOf(id) + 1;
    return {
      id, name: p.webName, pos: p.pos, club: club(id), priceM: p.cost, role: starting ? "starting" : "bench", slot,
      isCaptain: id === sel.captain, isVice: id === sel.vice,
      xptsNextGw: v.ep0, xptsRestOfSeasonDiscounted: v.value, xptsRestOfSeasonRaw: v.rawSeason, restAvgPerGw: v.restAvgPerGw,
      startProb: v.startProb, expMinutes: v.expMinutes, availabilityNow: v.availability0, rankInPosition: rank.get(id) as number,
      inCoreXI: core.has(id), fdrNext8: v.fdrNext8, fdrRest: v.fdrRest, reasons, benchReason,
    } as SlRow;
  });
}

/** Squad-level totals: this gameweek, and across the remaining season (best XI re-chosen every gameweek). */
export function seasonLongSummary(ds: Dataset, hz: SeasonHorizon, vals: Map<number, SlValue>, sel: { starting: number[]; bench: number[]; captain: number }) {
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const players = [...sel.starting, ...sel.bench].map((id) => by.get(id) as Player);
  const sv = squadValue(players, hz, ds);
  const raw = sv.perGw.reduce((a, b) => a + b, 0);
  const d = (id: number) => (hz.display.get(id) as Projection).ep;
  return {
    xiThisGw: r2(sel.starting.reduce((a, id) => a + d(id), 0) + d(sel.captain)),
    squad15ThisGw: r2([...sel.starting, ...sel.bench].reduce((a, id) => a + d(id), 0)),
    xiRestOfSeasonRaw: r2(raw),
    xiRestOfSeasonDiscounted: r2(sv.weighted),
    squad15RestOfSeasonRaw: r2([...sel.starting, ...sel.bench].reduce((a, id) => a + (vals.get(id) as SlValue).rawSeason, 0)),
    squad15RestOfSeasonDiscounted: r2([...sel.starting, ...sel.bench].reduce((a, id) => a + (vals.get(id) as SlValue).value, 0)),
    gameweeks: hz.gws.length,
    perGwXi: sv.perGw.map(r2),
  };
}

export function horizonInfo(hz: SeasonHorizon) {
  return { from: hz.gws[0], to: hz.endGw, gameweeks: hz.gws.length, discountPerGameweek: hz.params.discount, discountSum: r2(hz.discountSum), fixtureTrust: hz.params.fixtureTrust, futureAbsence: hz.params.futureAbsence, limitations: SEASON_LONG_LIMITATIONS };
}

/* ------------------------------------------------------------------ weekly transfer workflow */

export type SeasonLongTransfer = TransferDetail & {
  /** undiscounted rest-of-season xPts gained by this transfer (best XI re-chosen every gameweek) */
  gainRemainingSeasonRaw: number;
};

/** Reference: the existing 5-gameweek engine uses weights summing to this (1+.9+.8+.7+.6). */
const FIVE_GW_WEIGHT_SUM = 4;

/**
 * Weekly workflow: recompute rest-of-season projections (the horizon), find the weakest players and the best replacements,
 * and decide between using the free transfer, taking a hit, or rolling it over. Uses the EXISTING transfer engine (selling prices,
 * bank, club limit, free transfers, -4 hits) with the season horizon; its decision thresholds are scaled by the discount sum so a
 * longer horizon does not make every marginal move look worthwhile. Never forces a transfer.
 */
export function seasonLongTransfers(ds: Dataset, base: SeasonSquad, gw: number, hz: SeasonHorizon): TransferAnalysis & { options: (TransferAnalysis["options"][number] & { gainRemainingSeasonRaw: number; transfers: SeasonLongTransfer[] })[]; horizon: ReturnType<typeof horizonInfo> } {
  const scale = hz.discountSum / FIVE_GW_WEIGHT_SUM;
  const analysis = analyseTransfers(ds, base, gw, hz, { edgeScale: scale, bankScale: scale });
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const ones: Horizon = { ...hz, weights: hz.gws.map(() => 1) };
  const rawOf = (ids: number[]) => squadValue(ids.map((i) => by.get(i) as Player), ones, ds).weighted;
  const baseIds = base.holdings.map((h) => h.id);
  const baseRaw = rawOf(baseIds);
  const options = analysis.options.map((o) => {
    let ids = [...baseIds];
    let prev = baseRaw;
    const transfers = o.transfers.map((t) => {
      ids = ids.map((i) => (i === t.out ? t.in : i));
      const now = rawOf(ids);
      const gain = r2(now - prev);
      prev = now;
      return { ...t, gainRemainingSeasonRaw: gain };
    });
    return { ...o, transfers, gainRemainingSeasonRaw: r2(prev - baseRaw) };
  });
  return { ...analysis, options, horizon: horizonInfo(hz) };
}

export { lineupExpectedPoints };
