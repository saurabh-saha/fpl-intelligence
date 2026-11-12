import type { Lineup, Player, Pos, Projection, Rules, SquadResult } from "../fpl/types";
import { pickCaptains } from "./captainSelector";
import { allFormations, parseFormation } from "./validation";

const byValueDesc = (proj: Map<number, Projection>) => (a: Player, b: Player) => {
  const pa = proj.get(a.id)!;
  const pb = proj.get(b.id)!;
  return pb.score - pa.score || pb.ep - pa.ep || a.id - b.id;
};

/**
 * Best starting XI for a fixed 15-man squad: enumerate every legal formation, take the
 * top-N per position by selection score, keep the formation with the highest total.
 */
export function bestLineup(
  squad: Player[],
  proj: Map<number, Projection>,
  rules: Rules,
  preferredFormation?: string,
): Lineup {
  const cmp = byValueDesc(proj);
  const by = (pos: Pos) => squad.filter((p) => p.pos === pos).sort(cmp);
  const gk = by("GKP");
  const def = by("DEF");
  const mid = by("MID");
  const fwd = by("FWD");
  const val = (p: Player) => proj.get(p.id)!.score;

  const pref = preferredFormation ? parseFormation(preferredFormation) : null;
  let formations = allFormations(rules).filter(([d, m, f]) => d <= def.length && m <= mid.length && f <= fwd.length);
  if (pref) {
    const match = formations.filter(([d, m, f]) => d === pref[0] && m === pref[1] && f === pref[2]);
    if (match.length) formations = match;
  }

  let best: { f: [number, number, number]; total: number } | null = null;
  for (const f of formations) {
    const total =
      val(gk[0]) +
      def.slice(0, f[0]).reduce((s, p) => s + val(p), 0) +
      mid.slice(0, f[1]).reduce((s, p) => s + val(p), 0) +
      fwd.slice(0, f[2]).reduce((s, p) => s + val(p), 0);
    if (!best || total > best.total + 1e-9) best = { f, total };
  }
  if (!best) throw new Error("No legal formation for this squad");
  const [d, m, f] = best.f;

  const startingPlayers = [gk[0], ...def.slice(0, d), ...mid.slice(0, m), ...fwd.slice(0, f)];
  const startIds = new Set(startingPlayers.map((p) => p.id));
  const benchOutfield = [...def.slice(d), ...mid.slice(m), ...fwd.slice(f)].sort(cmp);
  // Bench order: substitute keeper first (FPL convention), then outfield by value.
  const bench = [...gk.slice(1), ...benchOutfield].map((p) => p.id);
  const starting = startingPlayers.map((p) => p.id);
  const byId = new Map(squad.map((p) => [p.id, p]));
  const { captain, viceCaptain } = pickCaptains([...startIds], proj, byId);
  return { starting, bench, formation: `${d}-${m}-${f}`, captain, viceCaptain };
}

/** Expected points of a lineup; the captain's points count twice. */
export function lineupExpectedPoints(lineup: Lineup, proj: Map<number, Projection>): number {
  const sum = lineup.starting.reduce((s, id) => s + (proj.get(id)?.ep ?? 0), 0);
  return Math.round((sum + (proj.get(lineup.captain)?.ep ?? 0)) * 100) / 100;
}

export function buildResult(
  squad: Player[],
  proj: Map<number, Projection>,
  rules: Rules,
  budgetTenths: number,
  preferredFormation?: string,
): SquadResult {
  const lineup = bestLineup(squad, proj, rules, preferredFormation);
  const total = squad.reduce((s, p) => s + p.costTenths, 0);
  return {
    ...lineup,
    squad: [...lineup.starting, ...lineup.bench],
    totalCostTenths: total,
    remainingTenths: budgetTenths - total,
    expectedPoints: lineupExpectedPoints(lineup, proj),
  };
}
