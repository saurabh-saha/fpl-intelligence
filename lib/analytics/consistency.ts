/** Per-gameweek history rows as returned by /api/element-summary/{id}/ `history`. */
export interface HistoryRow {
  round: number;
  total_points: number;
  minutes: number;
  goals_scored?: number;
  assists?: number;
  expected_goal_involvements?: string | number;
  starts?: number;
}

export interface Consistency {
  games: number;
  /** share of appearances with an attacking return (goal or assist) */
  returnRate: number;
  /** 0..1, how concentrated total points are in the best single match (1 = one huge haul) */
  haulShare: number;
  /** share of recent games with 60+ minutes */
  minutesStability: number;
  /** "consistent" | "streaky" | "hauls" | "n/a" */
  label: "consistent" | "streaky" | "hauls" | "n/a";
}

/**
 * Distinguishes a player who returns steadily from one whose points came in one match.
 * Needs per-gameweek history, which only element-summary provides.
 */
export function consistencyOf(history: HistoryRow[], lastN = 10): Consistency {
  const rows = history.filter((r) => r.minutes > 0).slice(-lastN);
  const all = history.slice(-lastN);
  if (rows.length < 3) return { games: rows.length, returnRate: 0, haulShare: 0, minutesStability: 0, label: "n/a" };
  const returns = rows.filter((r) => (r.goals_scored ?? 0) + (r.assists ?? 0) > 0).length;
  const positive = rows.map((r) => Math.max(0, r.total_points));
  const total = positive.reduce((a, b) => a + b, 0);
  const haulShare = total > 0 ? Math.max(...positive) / total : 0;
  const minutesStability = all.filter((r) => r.minutes >= 60).length / Math.max(1, all.length);
  const returnRate = returns / rows.length;
  const label = haulShare >= 0.35 ? "hauls" : returnRate >= 0.5 ? "consistent" : "streaky";
  return { games: rows.length, returnRate: round(returnRate), haulShare: round(haulShare), minutesStability: round(minutesStability), label };
}

const round = (n: number) => Math.round(n * 100) / 100;
