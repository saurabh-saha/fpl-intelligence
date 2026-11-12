import type { Components, Dataset, Fixture, Player, Pos, Projection, Team } from "../fpl/types";
import { POSITIONS } from "../fpl/types";
import {
  attackMultiplier,
  expectedGoalsConceded,
  fixturesForTeam,
  leagueContext,
  opponentAttackRatio,
  type LeagueContext,
} from "./fixtureAnalysis";

/* ------------------------------------------------------------------ maths */

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/** E[floor(X / d)] for X ~ Poisson(lambda). Used for "1 point per 2 goals conceded" / "per 3 saves". */
export function expFloorDiv(lambda: number, d: number): number {
  if (lambda <= 0) return 0;
  let e = 0;
  const max = Math.ceil(lambda + 10 * Math.sqrt(lambda) + 10);
  for (let k = d; k <= max; k++) e += Math.floor(k / d) * poissonPmf(k, lambda);
  return e;
}

export function normalCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ model */

/** Reliability: minutes at which an observed rate counts for 50% against the positional prior. */
export const SHRINK_MINUTES = 450;
/** Weight of xG/xA vs realised goals/assists when estimating a player's underlying rate. */
export const XG_WEIGHT = 0.8;
/** PRD factor weight for recent form; applied as a bounded tilt, never as extra independent points. */
export const FORM_WEIGHT = 0.1;
/** FPL defensive-contribution thresholds (the API only exposes the points, not the threshold). */
export const DC_THRESHOLD: Record<Pos, number> = { GKP: Infinity, DEF: 10, MID: 12, FWD: 12 };

interface Prior {
  g90: number;
  a90: number;
  bonus90: number;
  saves90: number;
  dc90: number;
  yellow90: number;
  red90: number;
}

export interface ModelContext {
  ds: Dataset;
  gw: number;
  nextId: number;
  lg: LeagueContext;
  priors: Record<Pos, Prior>;
}

export function computePriors(players: Player[]): Record<Pos, Prior> {
  const out = {} as Record<Pos, Prior>;
  for (const pos of POSITIONS) {
    const ps = players.filter((p) => p.pos === pos && p.minutes > 0);
    const n = ps.reduce((s, p) => s + p.minutes / 90, 0) || 1;
    const sum = (f: (p: Player) => number) => ps.reduce((s, p) => s + f(p), 0) / n;
    out[pos] = {
      g90: sum((p) => XG_WEIGHT * p.xG + (1 - XG_WEIGHT) * p.goals),
      a90: sum((p) => XG_WEIGHT * p.xA + (1 - XG_WEIGHT) * p.assists),
      bonus90: sum((p) => p.bonus),
      saves90: sum((p) => p.saves),
      dc90: sum((p) => p.defContrib),
      yellow90: sum((p) => p.yellow),
      red90: sum((p) => p.red),
    };
  }
  return out;
}

export function buildModelContext(ds: Dataset, gw: number): ModelContext {
  const nextId = ds.events.find((e) => e.isNext)?.id ?? ds.events.find((e) => !e.finished)?.id ?? gw;
  return { ds, gw, nextId, lg: leagueContext(ds), priors: computePriors(ds.players) };
}

/** Probability the player is fit and selected-available for `gw`. Never claims an injury the API does not state. */
export function availability(p: Player, gw: number, nextId: number): number {
  if (["u", "s", "n"].includes(p.status)) return 0;
  const chance = p.chanceNext;
  if (gw <= nextId) {
    if (chance !== null) return clamp(chance / 100, 0, 1);
    return p.status === "a" ? 1 : p.status === "d" ? 0.5 : 0.25;
  }
  // Further out the uncertainty decays towards a coin flip rather than assuming the news persists.
  if (chance !== null) return clamp(1 - (1 - chance / 100) * 0.5, 0, 1);
  return p.status === "a" ? 1 : p.status === "d" ? 0.75 : 0.5;
}

export interface MinutesModel {
  startProb: number;
  pAny: number;
  p60: number;
  expMinutes: number;
  avail: number;
}

export function minutesModel(p: Player, team: Team | undefined, gw: number, nextId: number): MinutesModel {
  const games = team?.played ?? 0;
  const avail = availability(p, gw, nextId);
  let startRate: number;
  let minsRate: number;
  if (games === 0) {
    startRate = 0.5;
    minsRate = 0.5;
  } else {
    startRate = clamp(p.starts / games, 0, 1);
    minsRate = clamp(p.minutes / (games * 90), 0, 1);
  }
  const startProb = clamp(0.7 * startRate + 0.3 * minsRate, 0, 1);
  const pAnySub = clamp(minsRate * 1.6, 0, 0.7);
  const pAny = avail * (startProb + (1 - startProb) * pAnySub);
  const p60 = avail * (startProb * 0.93 + (1 - startProb) * pAnySub * 0.08);
  const expMinutes = avail * (startProb * 80 + (1 - startProb) * pAnySub * 18);
  return { startProb, pAny, p60, expMinutes, avail };
}

/** Shrink an observed per-90 rate towards the positional prior in proportion to minutes played. */
export function shrunkRate(observedTotal: number, minutes: number, prior: number): number {
  if (minutes <= 0) return prior;
  const obs = observedTotal / (minutes / 90);
  const r = minutes / (minutes + SHRINK_MINUTES);
  return r * obs + (1 - r) * prior;
}

const emptyComponents = (): Components => ({
  appearance: 0,
  goals: 0,
  assists: 0,
  cleanSheet: 0,
  goalsConceded: 0,
  saves: 0,
  defContrib: 0,
  bonus: 0,
  cards: 0,
  formAdj: 0,
});

export function confidenceOf(p: Player, mm: MinutesModel) {
  const sample = Math.min(1, p.minutes / 1350);
  const availCert = (Math.max(mm.avail, 1 - mm.avail) - 0.5) * 2;
  // A projection for a likely non-starter is inherently uncertain, so confidence tracks the start probability.
  const score = clamp(0.45 * sample + 0.25 * availCert + 0.3 * mm.startProb, 0, 1);
  const label = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low";
  return { score, label } as const;
}

/**
 * Deterministic expected FPL points for one player in one gameweek.
 *
 * Built bottom-up from FPL's own scoring table (game_config.scoring):
 * appearance + goals + assists + clean sheet + goals conceded + saves + defensive contribution + bonus + cards.
 * Goals/assists use ONE blended rate (0.8*xG + 0.2*actual), never both as independent events.
 */
export function projectPlayer(p: Player, ctx: ModelContext, gwOverride?: number): Projection {
  const gw = gwOverride ?? ctx.gw;
  const { ds, lg, priors } = ctx;
  const sc = ds.scoring;
  const team = ds.teams[p.teamId];
  const fx = fixturesForTeam(ds.fixtures, ds.teams, p.teamId, gw);
  const mm = minutesModel(p, team, gw, ctx.nextId);
  const conf = confidenceOf(p, mm);
  const c = emptyComponents();

  if (fx.length > 0 && team) {
    const pr = priors[p.pos];
    const goalRate = shrunkRate(XG_WEIGHT * p.xG + (1 - XG_WEIGHT) * p.goals, p.minutes, pr.g90);
    const assistRate = shrunkRate(XG_WEIGHT * p.xA + (1 - XG_WEIGHT) * p.assists, p.minutes, pr.a90);
    const bonusRate = shrunkRate(p.bonus, p.minutes, pr.bonus90);
    const savesRate = shrunkRate(p.saves, p.minutes, pr.saves90);
    const dcRate = shrunkRate(p.defContrib, p.minutes, pr.dc90);
    const yellowRate = shrunkRate(p.yellow, p.minutes, pr.yellow90);
    const redRate = shrunkRate(p.red, p.minutes, pr.red90);
    const minsIfPlay = mm.pAny > 0 ? mm.expMinutes / mm.pAny : 0;
    const m = mm.expMinutes / 90;

    for (const f of fx) {
      const opp = ds.teams[f.oppId];
      if (!opp) continue;
      const am = attackMultiplier(opp, f.home, lg);
      const lambdaConceded = expectedGoalsConceded(team, opp, f.home, lg);

      c.appearance += sc.shortPlay * mm.pAny + (sc.longPlay - sc.shortPlay) * mm.p60;
      c.goals += goalRate * m * am * sc.goalsScored[p.pos];
      c.assists += assistRate * m * am * sc.assists;
      c.cleanSheet += Math.exp(-lambdaConceded) * mm.p60 * sc.cleanSheets[p.pos];
      c.goalsConceded += expFloorDiv(lambdaConceded, 2) * mm.p60 * sc.goalsConceded[p.pos];
      if (p.pos === "GKP") {
        const lambdaSaves = savesRate * m * Math.sqrt(opponentAttackRatio(opp, lg)) * (f.home ? 0.95 : 1.05);
        c.saves += expFloorDiv(lambdaSaves, 3) * sc.saves;
      }
      const dcPts = sc.defensiveContribution[p.pos];
      if (dcPts > 0 && mm.pAny > 0) {
        const M = (dcRate * minsIfPlay) / 90;
        const pHit = 1 - normalCdf((DC_THRESHOLD[p.pos] - 0.5 - M) / Math.sqrt(1.4 * M + 1));
        c.defContrib += dcPts * pHit * mm.pAny;
      }
      c.bonus += bonusRate * m * (0.5 + 0.5 * am) * sc.bonus;
      c.cards += (yellowRate * sc.yellowCards + redRate * sc.redCards) * m;
    }

    // Bounded form tilt (PRD weight 10%) on the non-appearance points; needs a minimal sample to mean anything.
    if (p.minutes >= 270 && p.ppg > 0) {
      const tilt = FORM_WEIGHT * clamp((p.form - p.ppg) / Math.max(p.ppg, 2), -1, 1);
      const base = c.goals + c.assists + c.cleanSheet + c.saves + c.defContrib + c.bonus;
      c.formAdj = base * tilt;
    }
  }

  const ep = Math.max(
    0,
    c.appearance + c.goals + c.assists + c.cleanSheet + c.goalsConceded + c.saves + c.defContrib + c.bonus + c.cards + c.formAdj,
  );
  return {
    playerId: p.id,
    gw,
    ep: round2(ep),
    score: round2(ep),
    confidence: conf.label,
    confidenceScore: round2(conf.score),
    startProb: round2(mm.startProb),
    availability: round2(mm.avail),
    expMinutes: Math.round(mm.expMinutes),
    fixtures: fx,
    components: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, round2(v)])) as unknown as Components,
    warnings: [],
    reasons: [],
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Convenience for tests / scripts: helper over a raw fixture list. */
export function fixtureCount(fixtures: Fixture[], teamId: number, gw: number) {
  return fixtures.filter((f) => f.event === gw && (f.teamH === teamId || f.teamA === teamId)).length;
}
