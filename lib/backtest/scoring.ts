import type { Pos } from "../fpl/types";

export interface Lineup {
  starting: number[];
  bench: number[];
  captain: number;
  vice: number;
}
export type Outcome = { points: number; minutes: number };

export interface GwScore {
  /** points that count: XI after automatic substitutions, plus the captain's extra points */
  points: number;
  basePoints: number;
  captainPoints: number;
  captainId: number;
  captainDidNotPlay: boolean;
  autoSubs: { out: number; in: number }[];
  /** points scored by bench players brought on by auto-subs */
  benchUsedPoints: number;
  /** points scored by bench players who stayed on the bench */
  benchUnusedPoints: number;
  finalXI: number[];
  starterMinutes: number[];
}

/**
 * FPL scoring for one gameweek with automatic substitutions and the vice-captain rule:
 * a starter with 0 minutes is replaced by the first bench player (in order) who played, if the formation stays legal
 * (a keeper only for a keeper); if the captain played 0 minutes the vice-captain's points are doubled instead.
 */
export function scoreGameweek(lineup: Lineup, out: (id: number) => Outcome, posOf: (id: number) => Pos): GwScore {
  const o = (id: number) => out(id) ?? { points: 0, minutes: 0 };
  let xi = [...lineup.starting];
  const bench = [...lineup.bench];
  const used = new Set<number>();
  const autoSubs: { out: number; in: number }[] = [];
  const legal = (ids: number[]) => {
    const c = (p: Pos) => ids.filter((i) => posOf(i) === p).length;
    return c("GKP") === 1 && c("DEF") >= 3 && c("MID") >= 2 && c("FWD") >= 1;
  };
  for (const id of lineup.starting) {
    if (o(id).minutes > 0) continue;
    for (const b of bench) {
      if (used.has(b) || o(b).minutes === 0) continue;
      if (posOf(id) === "GKP" ? posOf(b) !== "GKP" : posOf(b) === "GKP") continue;
      const next = xi.map((x) => (x === id ? b : x));
      if (!legal(next)) continue;
      xi = next;
      used.add(b);
      autoSubs.push({ out: id, in: b });
      break;
    }
  }
  const base = xi.reduce((a, id) => a + o(id).points, 0);
  let cap = lineup.captain;
  const captainDidNotPlay = o(cap).minutes === 0;
  if (captainDidNotPlay && o(lineup.vice).minutes > 0) cap = lineup.vice;
  const captainPoints = o(cap).points;
  return {
    points: base + captainPoints,
    basePoints: base,
    captainPoints,
    captainId: cap,
    captainDidNotPlay,
    autoSubs,
    benchUsedPoints: autoSubs.reduce((a, s) => a + o(s.in).points, 0),
    benchUnusedPoints: bench.filter((b) => !used.has(b)).reduce((a, b) => a + o(b).points, 0),
    finalXI: xi,
    starterMinutes: lineup.starting.map((id) => o(id).minutes),
  };
}
