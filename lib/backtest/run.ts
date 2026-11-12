import { projectAll } from "../analytics/playerScoring";
import type { Dataset, Mode, Pos } from "../fpl/types";
import { bestLineup } from "../optimizer/formationOptimizer";
import { optimizeSquad } from "../optimizer/squadOptimizer";
import { buildHorizon, type Horizon } from "../season/horizon";
import { balancedPlusValues, bestLineupBalancedPlus, optimizeBalancedPlus, type BpOptions } from "../strategies/balancedPlus";
import { historyQuality, pointInTime, rotationIndex, type AvailabilityMode, type SeasonData } from "./historical";
import { scoreGameweek } from "./scoring";

export const WINDOW = 5;

export interface StrategyDef {
  id: string;
  label: string;
  /** existing = unchanged optimiser and lineup rule; bp = Balanced Plus (possibly an ablation variant) */
  kind: "existing" | "bp";
  mode?: Mode;
  bp?: BpOptions;
  /** discount weights for a Balanced Plus variant (default: the shipped 1/.9/.8/.7/.6) */
  weights?: number[];
}

export const MAIN_STRATEGIES: StrategyDef[] = [
  { id: "balanced", label: "Balanced", kind: "existing", mode: "balanced" },
  { id: "safe", label: "Safe", kind: "existing", mode: "safe" },
  { id: "aggressive", label: "Aggressive", kind: "existing", mode: "aggressive" },
  { id: "balanced-plus", label: "Balanced Plus", kind: "bp" },
];

/** Ablations of Balanced Plus: DESCRIPTIVE sensitivity only, never used to choose parameters. */
export const BP_VARIANTS: StrategyDef[] = [
  { id: "bp-flat-weights", label: "BP flat discount (1,1,1,1,1)", kind: "bp", weights: [1, 1, 1, 1, 1] },
  { id: "bp-front-loaded", label: "BP front-loaded discount (1,.7,.5,.35,.25)", kind: "bp", weights: [1, 0.7, 0.5, 0.35, 0.25] },
  { id: "bp-no-security", label: "BP without minutes-security multiplier", kind: "bp", bp: { security: false } },
  { id: "bp-no-club-cap", label: "BP without the 2-per-club XI cap", kind: "bp", bp: { maxPerClubXI: 11 } },
  { id: "bp-keep-form-and-realised", label: "BP keeping form + realised goals/assists", kind: "bp", bp: { removeForm: false, xgOnly: false } },
];

export interface GwRecord {
  gw: number;
  formation: string;
  starting: number[];
  bench: number[];
  captain: number;
  vice: number;
  proj: number;
  actual: number;
  basePoints: number;
  captainPoints: number;
  captainDidNotPlay: boolean;
  /** 1 = the captain scored the most points of the starting XI */
  captainRank: number;
  /** best XI player's points minus the captain's points */
  captainRegret: number;
  autoSubs: number;
  benchUsedPoints: number;
  benchUnusedPoints: number;
  maxClubXI: number;
  xiMinutesAvg: number;
  xiDnp: number;
  xiUnder60: number;
  playerAbsErr: number;
  playerBias: number;
  relaxed: string;
}

export interface WindowRecord {
  season: string;
  k: number;
  rotation: number;
  strategies: Record<string, { squad: number[]; costTenths: number; points: number; captainPoints: number; projected: number; gws: GwRecord[] }>;
}

export interface SkippedWindow { season: string; k: number; reason: string }

interface Ctx {
  ds: Dataset;
  hz: Horizon;
  proj: Record<Mode, Map<number, import("../fpl/types").Projection>>;
}

const withWeights = (hz: Horizon, w: number[]): Horizon => ({ ...hz, weights: w.slice(0, hz.gws.length) });

export interface RunOptions {
  sd: SeasonData;
  strategies: StrategyDef[];
  availability: AvailabilityMode;
  /** first deadline to test (history needed before it) */
  firstK: number;
  lastK?: number;
  onProgress?: (k: number) => void;
}

/**
 * Rolling five-gameweek windows for one season. At deadline k each strategy buys a legal 15-man squad from data
 * available before k and holds it for GW k..k+4; each gameweek its own lineup rule picks XI/bench/captain from data
 * available at THAT gameweek's deadline. Outcomes are read only after those choices.
 */
export function runSeason(o: RunOptions): { windows: WindowRecord[]; skipped: SkippedWindow[] } {
  const { sd } = o;
  const cache = new Map<number, Ctx>();
  const ctxAt = (t: number): Ctx => {
    let c = cache.get(t);
    if (!c) {
      const ds = pointInTime(sd, t, { availability: o.availability });
      const hz = buildHorizon(ds, t);
      const proj = {} as Ctx["proj"];
      for (const m of ["balanced", "safe", "aggressive"] as Mode[]) proj[m] = projectAll(ds, t, { mode: m }).byId;
      c = { ds, hz, proj };
      cache.set(t, c);
    }
    return c;
  };
  const windows: WindowRecord[] = [];
  const skipped: SkippedWindow[] = [];
  const last = Math.min(o.lastK ?? 38 - (WINDOW - 1), sd.maxGw - (WINDOW - 1));

  for (let k = o.firstK; k <= last; k++) {
    const gws = Array.from({ length: WINDOW }, (_, j) => k + j);
    const missing = gws.filter((g) => !sd.gwsWithFixtures.has(g));
    if (missing.length) { skipped.push({ season: sd.season, k, reason: `no fixtures recorded for GW${missing.join(",")}` }); continue; }
    const q = historyQuality(sd, k);
    if (!q.ok) { skipped.push({ season: sd.season, k, reason: q.reason! }); continue; }
    const ck = ctxAt(k);
    const rotation = gws.reduce((a, g) => a + rotationIndex(sd, g), 0) / WINDOW;
    const rec: WindowRecord = { season: sd.season, k, rotation, strategies: {} };

    for (const st of o.strategies) {
      // 1. squad selection with information available before deadline k
      let squad: number[];
      let cost: number;
      if (st.kind === "existing") {
        const r = optimizeSquad(ck.ds, ck.proj[st.mode!], { mode: st.mode! }).result;
        squad = r.squad;
        cost = r.totalCostTenths;
      } else {
        const hzv = st.weights ? withWeights(ck.hz, st.weights) : ck.hz;
        const r = optimizeBalancedPlus(ck.ds, hzv, st.bp ?? {});
        squad = r.squad;
        cost = r.totalCostTenths;
      }
      // 2. hold it; choose the lineup at each gameweek's own deadline; then (and only then) read outcomes
      const gwRecs: GwRecord[] = [];
      for (const t of gws) {
        const ct = ctxAt(t);
        const byId = new Map(ct.ds.players.map((p) => [p.id, p]));
        const players = squad.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
        if (players.length !== squad.length) throw new Error(`squad member unknown at GW${t} (${sd.season})`);
        let lineup: { starting: number[]; bench: number[]; captain: number; vice: number; formation: string };
        let relaxed = "none";
        if (st.kind === "existing") {
          const l = bestLineup(players, ct.proj[st.mode!], ct.ds.rules);
          lineup = { starting: l.starting, bench: l.bench, captain: l.captain, vice: l.viceCaptain, formation: l.formation };
        } else {
          const hzt = st.weights ? withWeights(ct.hz, st.weights) : ct.hz;
          const l = bestLineupBalancedPlus(ct.ds, hzt, squad, st.bp ?? {}, balancedPlusValues(ct.ds, hzt, st.bp ?? {}));
          lineup = l;
          relaxed = l.relaxed;
        }
        const out = (id: number) => sd.actual.get(t)?.get(id) ?? { points: 0, minutes: 0 };
        const posOf = (id: number): Pos => byId.get(id)!.pos;
        const sc = scoreGameweek(lineup, out, posOf);
        const ep = (id: number) => ct.proj.balanced.get(id)!.ep;
        const proj = lineup.starting.reduce((a, id) => a + ep(id), 0) + ep(lineup.captain);
        const clubs = new Map<number, number>();
        lineup.starting.forEach((id) => clubs.set(byId.get(id)!.teamId, (clubs.get(byId.get(id)!.teamId) ?? 0) + 1));
        const errs = lineup.starting.map((id) => ep(id) - out(id).points);
        const xiPts = lineup.starting.map((id) => out(id).points);
        const capPts = out(lineup.captain).points;
        gwRecs.push({
          gw: t, formation: lineup.formation, starting: lineup.starting, bench: lineup.bench, captain: lineup.captain, vice: lineup.vice,
          proj, actual: sc.points, basePoints: sc.basePoints, captainPoints: sc.captainPoints, captainDidNotPlay: sc.captainDidNotPlay,
          captainRank: 1 + xiPts.filter((v) => v > capPts).length, captainRegret: Math.max(...xiPts) - capPts,
          autoSubs: sc.autoSubs.length, benchUsedPoints: sc.benchUsedPoints, benchUnusedPoints: sc.benchUnusedPoints,
          maxClubXI: Math.max(...clubs.values()),
          xiMinutesAvg: sc.starterMinutes.reduce((a, b) => a + b, 0) / 11,
          xiDnp: sc.starterMinutes.filter((m) => m === 0).length,
          xiUnder60: sc.starterMinutes.filter((m) => m < 60).length,
          playerAbsErr: errs.reduce((a, e) => a + Math.abs(e), 0) / 11,
          playerBias: errs.reduce((a, e) => a + e, 0) / 11,
          relaxed,
        });
      }
      rec.strategies[st.id] = {
        squad, costTenths: cost,
        points: gwRecs.reduce((a, g) => a + g.actual, 0),
        captainPoints: gwRecs.reduce((a, g) => a + g.captainPoints, 0),
        projected: gwRecs.reduce((a, g) => a + g.proj, 0),
        gws: gwRecs,
      };
    }
    windows.push(rec);
    o.onProgress?.(k);
    // contexts older than the window are no longer needed
    for (const key of cache.keys()) if (key < k) cache.delete(key);
  }
  return { windows, skipped };
}
