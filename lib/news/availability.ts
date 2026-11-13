import { minutesModel } from "../analytics/expectedPoints";
import type { Player, Team } from "../fpl/types";
import type { NewsEvent, NewsImpact } from "./types";

/**
 * Deterministic availability adjustment. News changes only the AVAILABILITY / MINUTES inputs of the existing
 * expected-points model; it never adds or removes points directly, and an LLM is never involved here.
 *
 * Principles (each is covered by tests):
 *  - Only events with evidence move anything; a mention alone does nothing (impact "none").
 *  - Rumours are weighted by status (confirmed 1, reported 0.6, speculative 0.25) x source reliability x extraction
 *    confidence, combined across DISTINCT sources only (see events.ts).
 *  - News never stacks on top of what FPL's status/chance already says: the unavailability used is the more
 *    pessimistic of the two, not their product.
 *  - International duty does not imply a missed league game; it can only cost minutes right after a late return.
 *  - Absences with no stated return date fade with a severity-specific time constant, they are not permanent.
 */
export const PARAMS = {
  /** days after which an undated absence is half as likely to still apply = tau * ln2; by severity */
  tauDays: { minor: 5, moderate: 18, major: 60, info: 3 },
  doubtOutShare: 0.5, // a "doubt" is at most a 50% chance of missing the game
  doubtTauDays: 4,
  maxStartCut: { rotation: 0.35, international_fatigue: 0.2, late_return: 0.4, international_duty: 0.25, other: 0.2 } as Record<string, number>,
  minutesTauDays: { rotation: 7, international_fatigue: 5, late_return: 7, international_duty: 5, other: 5 } as Record<string, number>,
  returnRampDays: 14, // first match back is rusty: 0.8 -> 1.0 over two weeks
  returnRampFloor: 0.8,
  confirmedFitWindowDays: 2,
  maxPOut: 0.97,
  lateReturnWindowDays: 5, // fatigue / late return only matters for a match this soon after the player is back
};

const DAY = 86_400_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AvailabilityInput {
  player: Player;
  team: Team | undefined;
  gw: number;
  nextId: number;
  /** kickoff of the player's first match in `gw` */
  kickoff: Date;
  events: NewsEvent[];
  now: Date;
}

export interface AvailabilityResult {
  baseAvailability: number;
  adjustedAvailability: number;
  baseStartProbability: number; // P(start) incl. availability
  adjustedStartProbability: number;
  baseExpectedMinutes: number;
  adjustedExpectedMinutes: number;
  /** availability to hand to the unchanged xPts model so that it reproduces adjustedExpectedMinutes */
  engineAvailability: number;
  availabilityStatus: NewsImpact["availabilityStatus"];
  availabilityConfidence: number;
  reasonCodes: string[];
  reasons: string[];
  supportingNewsIds: string[];
}

interface Effect { pOut: number; sf: number; override?: number; code: string; text: string; ids: string[]; belief: number; }

const pct = (x: number) => `${Math.round(x * 100)}%`;
const rampAfter = (days: number) => (days < 0 ? 0 : clamp(PARAMS.returnRampFloor + (1 - PARAMS.returnRampFloor) * (days / PARAMS.returnRampDays), PARAMS.returnRampFloor, 1));
const retMs = (d: string) => Date.parse(d + "T00:00:00Z");

function effectOf(ev: NewsEvent, p: Player, gw: number, nextId: number, K: Date, now: Date): Effect | null {
  const c = ev.current;
  if (!ev.active || ev.belief <= 0) return null;
  const E = ev.belief * (ev.contradicted ? 0.5 : 1);
  const days = (K.getTime() - Date.parse(c.publishedAt)) / DAY;
  const src = `${ev.independentSources.length} independent source${ev.independentSources.length === 1 ? "" : "s"}`;
  const ids = ev.items.map((i) => i.id);
  const ret = c.expectedReturnDate ? retMs(c.expectedReturnDate) : null;
  const status = c.status;

  if (c.impact === "none") return null;

  if (c.impact === "out") {
    if (c.representedInFpl) {
      // FPL's own status already drives the next gameweek; the official return date only improves later ones.
      if (gw <= nextId || ret === null) return null;
      const away = K.getTime() < ret;
      const e = Math.min(E, 0.95);
      const a = away ? 1 - e : rampAfter((K.getTime() - ret) / DAY);
      return { pOut: 0, sf: 1, override: clamp(a, 0, 1), code: away ? "FPL_RETURN_DATE_AFTER" : "FPL_RETURN_DATE_PASSED", text: away ? `FPL lists a return on ${c.expectedReturnDate}, after this match.` : `FPL's stated return date (${c.expectedReturnDate}) has passed by this match; first game back, so minutes are slightly eased.`, ids, belief: e };
    }
    if (ret !== null) {
      if (K.getTime() < ret) return { pOut: Math.min(PARAMS.maxPOut, E), sf: 1, code: status === "confirmed" ? "CONFIRMED_OUT_UNTIL_DATE" : "REPORTED_OUT_UNTIL_DATE", text: `${status === "confirmed" ? "Confirmed" : "Reported"} absence until ${c.expectedReturnDate} (${src}); this match is before the return date.`, ids, belief: E };
      const ramp = rampAfter((K.getTime() - ret) / DAY);
      if (ramp < 1) return { pOut: 0, sf: 1 - E * (1 - ramp), code: "RETURNING_FROM_ABSENCE", text: `Expected back from ${c.expectedReturnDate}; the first matches after a return are eased in.`, ids, belief: E };
      return null;
    }
    const tau = PARAMS.tauDays[c.severity];
    const pOut = Math.min(PARAMS.maxPOut, E * Math.exp(-Math.max(0, days) / tau));
    return { pOut, sf: 1, code: status === "confirmed" ? "CONFIRMED_OUT_NO_DATE" : status === "reported" ? "REPORTED_OUT_NO_DATE" : "SPECULATIVE_OUT", text: `${status === "confirmed" ? "Confirmed" : status === "reported" ? "Reported" : "Speculative"} ${c.severity} absence with no return date (${src}); the chance it still applies fades over time (${pct(pOut)} out for this match). ${status === "confirmed" ? "" : "Not confirmed as unavailable."}`.trim(), ids, belief: E };
  }

  if (c.impact === "doubt") {
    const pOut = PARAMS.doubtOutShare * E * Math.exp(-Math.max(0, days) / PARAMS.doubtTauDays);
    return { pOut, sf: 1, code: status === "confirmed" ? "CONFIRMED_DOUBT" : "REPORTED_DOUBT", text: `Starting probability reduced because of a ${status === "confirmed" ? "confirmed" : "reported"} fitness concern (${src}). The player is not confirmed unavailable.`, ids, belief: E };
  }

  if (c.impact === "reduced") {
    const key = c.category in PARAMS.minutesTauDays ? c.category : "other";
    const tau = PARAMS.minutesTauDays[key];
    const anchor = ret ?? Date.parse(c.publishedAt);
    const since = (K.getTime() - anchor) / DAY;
    // Fatigue/late-return only bites for a match soon after the anchor; otherwise it has worn off.
    if ((c.category === "international_fatigue" || c.category === "late_return" || c.category === "international_duty") && (since < -0.5 || since > PARAMS.lateReturnWindowDays)) return null;
    const cut = PARAMS.maxStartCut[key] * E * Math.exp(-Math.max(0, days) / (tau * 2));
    if (cut < 0.005) return null;
    const code = c.category === "rotation" ? "ROTATION_RISK" : c.category === "late_return" ? "LATE_RETURN" : c.category === "international_duty" ? "INTERNATIONAL_RETURN" : "FATIGUE_RISK";
    return { pOut: 0, sf: 1 - cut, code, text: `${c.category === "rotation" ? "Rotation risk" : c.category === "late_return" ? "Late return" : c.category === "international_duty" ? "Back from international duty" : "Fatigue"}: start probability trimmed by ${pct(cut)} (${status}, ${src}). The player is still expected to be available.`, ids, belief: E };
  }

  if (c.impact === "fit") {
    // Confirmed team news / "available for selection" only matters close to kickoff, and never revives a suspended or departed player.
    if (p.status === "u" || p.status === "n") return null;
    const sinceDays = (K.getTime() - Date.parse(c.publishedAt)) / DAY;
    if (sinceDays < -0.1 || sinceDays > PARAMS.confirmedFitWindowDays || E < 0.5) return null;
    return { pOut: 0, sf: 1, override: 1, code: "CONFIRMED_AVAILABLE", text: `Cleared to play per ${status} team news (${src}).`, ids, belief: E };
  }
  void now;
  return null;
}

export function adjustAvailability(inp: AvailabilityInput): AvailabilityResult | null {
  const { player: p, team, gw, nextId, kickoff, events, now } = inp;
  const mm = minutesModel(p, team, gw, nextId);
  const effects = events.map((e) => effectOf(e, p, gw, nextId, kickoff, now)).filter((e): e is Effect => e !== null);
  if (!effects.length) return null;

  const overrides = effects.filter((e) => e.override !== undefined);
  const fplOverrides = overrides.filter((o) => o.code.startsWith("FPL")).map((o) => o.override!);
  const aStart = fplOverrides.length ? Math.min(...fplOverrides) : NaN;
  const fitOverride = overrides.find((o) => o.code === "CONFIRMED_AVAILABLE");
  const a0 = mm.avail;
  const reference = Number.isFinite(aStart) ? aStart : fitOverride ? Math.max(a0, fitOverride.override!) : a0;
  // News is never stacked on FPL's own signal: use the more pessimistic of the two.
  const notOut = effects.reduce((acc, e) => acc * (1 - e.pOut), 1);
  const a1 = clamp(Math.min(reference, notOut), 0, 1);
  const sf = effects.reduce((acc, e) => acc * e.sf, 1);
  if (Math.abs(a1 - a0) < 1e-9 && Math.abs(sf - 1) < 1e-9) return null;

  const games = team?.played ?? 0;
  const minsRate = games === 0 ? 0.5 : clamp(p.minutes / (games * 90), 0, 1);
  const pSub = clamp(minsRate * 1.6, 0, 0.7);
  const s0 = mm.startProb;
  const s1 = clamp(s0 * sf, 0, 1);
  const unit = (s: number) => s * 80 + (1 - s) * pSub * 18;
  const m1 = a1 * unit(s1);
  const engineAvailability = unit(s0) > 0 ? clamp(m1 / unit(s0), 0, 1) : a1;

  const status = a1 <= 0.05 ? "out" : a1 < 0.35 ? "likely-out" : a1 < 0.8 ? "doubtful" : effects.some((e) => e.code === "RETURNING_FROM_ABSENCE" || e.code.startsWith("FPL_RETURN_DATE_PASSED")) ? "returning" : sf < 0.85 ? "reduced-minutes" : "available";
  const conf = Math.max(...effects.map((e) => e.belief));
  const codes = effects.map((e) => e.code);
  if (events.some((e) => e.contradicted)) codes.push("CONTRADICTORY_REPORTS");
  const reasons = effects.map((e) => e.text);
  if (events.some((e) => e.contradicted)) reasons.push("Sources disagree about this player, so the effect is halved.");
  if (a1 < a0 - 1e-9 && a0 < 0.999) reasons.push(`FPL already shows ${pct(a0)} availability; the news is used only where it is more pessimistic, never added on top.`);
  return {
    baseAvailability: r2(a0),
    adjustedAvailability: r2(a1),
    baseStartProbability: r2(a0 * s0),
    adjustedStartProbability: r2(a1 * s1),
    baseExpectedMinutes: Math.round(a0 * unit(s0)),
    adjustedExpectedMinutes: Math.round(m1),
    engineAvailability,
    availabilityStatus: status,
    availabilityConfidence: r2(conf * (events.some((e) => e.contradicted) ? 0.5 : 1)),
    reasonCodes: [...new Set(codes)],
    reasons,
    supportingNewsIds: [...new Set(effects.flatMap((e) => e.ids))],
  };
}
