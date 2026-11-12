import type { ChipName, Dataset, Player, Projection } from "../fpl/types";
import { projectPlayer } from "../analytics/expectedPoints";
import { bestLineup, lineupExpectedPoints } from "../optimizer/formationOptimizer";
import { optimizeSquad } from "../optimizer/squadOptimizer";
import { buildHorizon, squadValue, type Horizon } from "./horizon";
import { chipErrors, chipStatuses } from "./rules";
import { byIdMap, totalBudgetTenths } from "./squad";
import type { PlannedTransfer, SeasonSquad } from "./types";
import { CHIP_LABEL } from "./types";

/** Minimum expected gain (points) before a chip is worth playing now rather than saving it. */
export const CHIP_THRESHOLD: Record<ChipName, number> = { bboost: 8, "3xc": 7, freehit: 14, wildcard: 12 };
const LOOKAHEAD = 8;
const FH_LOOKAHEAD = 5;

export interface ChipOptionGw {
  gw: number;
  gain: number;
  doubleTeams: number;
  blankTeams: number;
}

export interface ChipAdvice {
  chip: ChipName;
  label: string;
  available: boolean;
  unavailableReason?: string;
  window: { start: number; stop: number } | null;
  nowGain: number;
  best: { gw: number; gain: number } | null;
  options: ChipOptionGw[];
  verdict: "use-now" | "save" | "use-soon" | "unavailable";
  text: string;
}

function fixtureShape(ds: Dataset, gw: number) {
  const count = new Map<number, number>();
  for (const f of ds.fixtures) if (f.event === gw) {
    count.set(f.teamH, (count.get(f.teamH) ?? 0) + 1);
    count.set(f.teamA, (count.get(f.teamA) ?? 0) + 1);
  }
  const teams = Object.keys(ds.teams).map(Number);
  return { doubleTeams: teams.filter((t) => (count.get(t) ?? 0) >= 2).length, blankTeams: teams.filter((t) => !count.get(t)).length };
}

function projFor(hz: Horizon, ds: Dataset, g: number): Map<number, Projection> {
  const i = hz.gws.indexOf(g);
  if (i >= 0) return hz.proj[i];
  const m = new Map<number, Projection>();
  for (const p of ds.players) {
    const pr = projectPlayer(p, hz.ctx, g);
    m.set(p.id, { ...pr, score: pr.ep });
  }
  return m;
}

/** Bench Boost: all 15 score. Gain = what the four bench players add. */
export function benchBoostGain(players: Player[], proj: Map<number, Projection>, ds: Dataset): number {
  const l = bestLineup(players, proj, ds.rules);
  return round(l.bench.reduce((s, id) => s + (proj.get(id)?.ep ?? 0), 0));
}
/** Triple Captain: captain scores x3 instead of x2. Gain = captain's expected points. */
export function tripleCaptainGain(players: Player[], proj: Map<number, Projection>, ds: Dataset): number {
  const l = bestLineup(players, proj, ds.rules);
  return round(proj.get(l.captain)?.ep ?? 0);
}

/** Expected points of a squad in `gw` with an optional chip (BB: 15 players; TC: captain x3). */
export function chipExpectedPoints(players: Player[], proj: Map<number, Projection>, ds: Dataset, chip: ChipName | null | undefined): number {
  const l = bestLineup(players, proj, ds.rules);
  const base = lineupExpectedPoints(l, proj);
  if (chip === "bboost") return round(base + l.bench.reduce((s, id) => s + (proj.get(id)?.ep ?? 0), 0));
  if (chip === "3xc") return round(base + (proj.get(l.captain)?.ep ?? 0));
  return base;
}

export function planFreeHit(ds: Dataset, base: SeasonSquad, gw: number, hz: Horizon) {
  const by = byIdMap(ds);
  const proj = projFor(hz, ds, gw);
  const budget = totalBudgetTenths(base, ds);
  const { result } = optimizeSquad(ds, proj, { mode: "balanced", budgetTenths: budget, overCap: true });
  const cur = base.holdings.map((h) => by.get(h.id)!);
  const baseEp = lineupExpectedPoints(bestLineup(cur, proj, ds.rules), proj);
  return { ids: result.squad, ep: result.expectedPoints, baseEp: round(baseEp), gain: round(result.expectedPoints - baseEp), budgetTenths: budget };
}

export function planWildcard(ds: Dataset, base: SeasonSquad, _gw: number, hz: Horizon) {
  const by = byIdMap(ds);
  const blended = new Map<number, Projection>();
  const wsum = hz.weights.reduce((a, b) => a + b, 0);
  for (const p of ds.players) {
    const v = hz.proj.reduce((s, m, k) => s + m.get(p.id)!.ep * hz.weights[k], 0) / wsum;
    blended.set(p.id, { ...hz.proj[0].get(p.id)!, score: v });
  }
  const budget = totalBudgetTenths(base, ds);
  const { result } = optimizeSquad(ds, blended, { mode: "balanced", budgetTenths: budget, overCap: true });
  const cur = new Set(base.holdings.map((h) => h.id));
  const next = new Set(result.squad);
  const outs = base.holdings.map((h) => h.id).filter((id) => !next.has(id));
  const ins = result.squad.filter((id) => !cur.has(id));
  // pair by position so the plan reads as transfers (legality is checked on the final squad)
  const transfers: PlannedTransfer[] = [];
  const pool = [...ins];
  for (const o of outs) {
    const i = pool.findIndex((x) => by.get(x)!.pos === by.get(o)!.pos);
    transfers.push({ out: o, in: pool.splice(i, 1)[0] });
  }
  const before = squadValue(base.holdings.map((h) => by.get(h.id)!), hz, ds).weighted;
  const after = squadValue(result.squad.map((id) => by.get(id)!), hz, ds).weighted;
  return { transfers, newIds: result.squad, gainHorizon: round(after - before), budgetTenths: budget };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Chip strategy. For each chip still available this half-season, estimate the gain in every
 * remaining candidate gameweek, then recommend using it now only when the gain is big enough and
 * near the best available; otherwise save it (or name the better gameweek). A chip about to expire
 * is steered to its best remaining gameweek.
 * `bestNormalNet` = best net gain from ordinary transfers, so Wildcard is credited only for what transfers can't do.
 */
export function chipStrategy(ds: Dataset, base: SeasonSquad, gw: number, bestNormalNet = 0, hzIn?: Horizon): ChipAdvice[] {
  const hz = hzIn ?? buildHorizon(ds, gw);
  const by = byIdMap(ds);
  const players = base.holdings.map((h) => by.get(h.id)!);
  const statuses = chipStatuses(ds, base.chipsUsed, gw);
  const advice: ChipAdvice[] = [];

  for (const st of statuses) {
    const label = CHIP_LABEL[st.name];
    const legalNow = chipErrors(ds, base.chipsUsed, gw, st.name);
    if (!st.available || !st.window) {
      advice.push({ chip: st.name, label, available: false, unavailableReason: st.reason, window: st.window, nowGain: 0, best: null, options: [], verdict: "unavailable", text: `${label} is not available: ${st.reason ?? "no window open"}.` });
      continue;
    }
    const last = Math.min(st.window.stop, gw + (st.name === "freehit" ? FH_LOOKAHEAD : LOOKAHEAD), ds.events[ds.events.length - 1].id);
    const options: ChipOptionGw[] = [];
    for (let g = gw; g <= last; g++) {
      if (chipErrors(ds, base.chipsUsed, g, st.name).length > 0 && g === gw) {
        // illegal right now (e.g. another chip already this GW): still evaluate later gameweeks
      }
      if (st.name === "freehit" && g === 1) continue;
      const proj = projFor(hz, ds, g);
      let gain = 0;
      if (st.name === "bboost") gain = benchBoostGain(players, proj, ds);
      else if (st.name === "3xc") gain = tripleCaptainGain(players, proj, ds);
      else if (st.name === "freehit") gain = planFreeHit(ds, base, g, hz).gain;
      else if (st.name === "wildcard" && g === gw) gain = round(planWildcard(ds, base, g, hz).gainHorizon - Math.max(0, bestNormalNet));
      else continue; // wildcard: only evaluated for right now
      options.push({ gw: g, gain, ...fixtureShape(ds, g) });
    }
    const now = options.find((o) => o.gw === gw)?.gain ?? 0;
    const best = options.reduce<ChipOptionGw | null>((b, o) => (!b || o.gain > b.gain ? o : b), null);
    const gwsLeft = st.window.stop - gw;
    const threshold = CHIP_THRESHOLD[st.name];
    let verdict: ChipAdvice["verdict"];
    let text: string;
    const shape = best ? ` (GW${best.gw}${best.doubleTeams ? `: ${best.doubleTeams} clubs double` : ""}${best.blankTeams ? `, ${best.blankTeams} clubs blank` : ""})` : "";
    const basis = st.name === "bboost" || st.name === "3xc" ? " based on your current squad" : "";
    if (legalNow.length && now >= 0) {
      verdict = "save";
      text = `Cannot play ${label} this gameweek: ${legalNow[0]}`;
    } else if (gwsLeft <= 3) {
      if (best && best.gw === gw) { verdict = "use-now"; text = `${label} expires after GW${st.window.stop} and now is its best remaining gameweek (+${now.toFixed(1)} pts${basis}). Use it.`; }
      else { verdict = "use-soon"; text = `${label} expires after GW${st.window.stop}. Best remaining gameweek is GW${best?.gw} (+${best?.gain.toFixed(1)} pts${basis}), versus +${now.toFixed(1)} now. Use it by then or lose it.`; }
    } else if (now >= threshold && best && now >= best.gain * 0.9) {
      verdict = "use-now";
      text = `+${now.toFixed(1)} expected points now, within 10% of the best window found${shape}${basis}. Worth playing.`;
    } else {
      verdict = "save";
      text = best && best.gw !== gw && best.gain > now
        ? `Save it: +${now.toFixed(1)} now but +${best.gain.toFixed(1)} in GW${best.gw}${shape}${basis}.`
        : `Save it: +${now.toFixed(1)} now is below the ${threshold}-point bar for this chip${basis}.`;
    }
    advice.push({ chip: st.name, label, available: true, window: st.window, nowGain: now, best: best ? { gw: best.gw, gain: best.gain } : null, options, verdict, text });
  }
  return advice;
}
