import type { Player, Projection } from "../fpl/types";

/**
 * Captain = highest expected points among starters (selection score breaks ties).
 * Vice-captain = best remaining option, preferring a reliable starter so the armband isn't wasted
 * if the captain does not play.
 */
export function pickCaptains(
  starting: number[],
  proj: Map<number, Projection>,
  players: Map<number, Player>,
): { captain: number; viceCaptain: number } {
  const ranked = [...starting].sort((a, b) => {
    const pa = proj.get(a)!;
    const pb = proj.get(b)!;
    return pb.ep - pa.ep || pb.score - pa.score || a - b;
  });
  const captain = ranked[0];
  const rest = ranked.slice(1);
  const reliable = rest.filter((id) => (proj.get(id)?.startProb ?? 0) >= 0.8 && (proj.get(id)?.availability ?? 0) >= 0.9);
  const viceCaptain = (reliable[0] ?? rest[0]) as number;
  void players;
  return { captain, viceCaptain };
}
