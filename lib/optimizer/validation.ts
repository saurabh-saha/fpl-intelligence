import { POSITIONS, type Lineup, type Player, type Pos, type Rules } from "../fpl/types";

export interface Validation {
  valid: boolean;
  errors: string[];
}

export function parseFormation(f: string): [number, number, number] | null {
  const m = /^(\d)-(\d)-(\d)$/.exec(f.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formationValid(d: number, m: number, f: number, rules: Rules): boolean {
  return (
    d + m + f === rules.startingSize - 1 &&
    d >= rules.minPlay.DEF && d <= rules.maxPlay.DEF &&
    m >= rules.minPlay.MID && m <= rules.maxPlay.MID &&
    f >= rules.minPlay.FWD && f <= rules.maxPlay.FWD
  );
}

export function allFormations(rules: Rules): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let d = rules.minPlay.DEF; d <= rules.maxPlay.DEF; d++)
    for (let m = rules.minPlay.MID; m <= rules.maxPlay.MID; m++)
      for (let f = rules.minPlay.FWD; f <= rules.maxPlay.FWD; f++)
        if (formationValid(d, m, f, rules)) out.push([d, m, f]);
  return out;
}

/** Squad-level rules: size, positions, club limit, budget, duplicates. */
export function validateSquad(
  ids: number[],
  byId: Map<number, Player>,
  rules: Rules,
  budgetTenths: number = rules.budgetTenths,
): Validation {
  const errors: string[] = [];
  if (ids.length !== rules.squadSize) errors.push(`Squad must have ${rules.squadSize} players (has ${ids.length}).`);
  if (new Set(ids).size !== ids.length) errors.push("Squad contains duplicate players.");
  const players: Player[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) errors.push(`Unknown player ${id}.`);
    else players.push(p);
  }
  for (const pos of POSITIONS) {
    const n = players.filter((p) => p.pos === pos).length;
    if (n !== rules.quota[pos]) errors.push(`Need ${rules.quota[pos]} ${pos}, have ${n}.`);
  }
  const perTeam = new Map<number, number>();
  for (const p of players) perTeam.set(p.teamId, (perTeam.get(p.teamId) ?? 0) + 1);
  for (const [team, n] of perTeam) if (n > rules.teamLimit) errors.push(`Max ${rules.teamLimit} players per club (team ${team} has ${n}).`);
  const cost = players.reduce((s, p) => s + p.costTenths, 0);
  if (cost > budgetTenths) errors.push(`Over budget: £${(cost / 10).toFixed(1)}m > £${(budgetTenths / 10).toFixed(1)}m.`);
  return { valid: errors.length === 0, errors };
}

/** Starting XI / bench rules. */
export function validateLineup(lineup: Lineup, squadIds: number[], byId: Map<number, Player>, rules: Rules): Validation {
  const errors: string[] = [];
  const { starting, bench } = lineup;
  if (starting.length !== rules.startingSize) errors.push(`Starting XI must have ${rules.startingSize} players.`);
  if (bench.length !== rules.squadSize - rules.startingSize) errors.push("Bench size is wrong.");
  const all = [...starting, ...bench];
  if (new Set(all).size !== all.length) errors.push("Lineup has duplicates.");
  if (all.length !== squadIds.length || !all.every((id) => squadIds.includes(id))) errors.push("Lineup does not match squad.");
  const xi = starting.map((id) => byId.get(id)).filter((p): p is Player => !!p);
  const count = (pos: Pos) => xi.filter((p) => p.pos === pos).length;
  if (count("GKP") !== 1) errors.push("Starting XI needs exactly 1 goalkeeper.");
  for (const pos of ["DEF", "MID", "FWD"] as Pos[]) {
    if (count(pos) < rules.minPlay[pos]) errors.push(`Starting XI needs at least ${rules.minPlay[pos]} ${pos}.`);
    if (count(pos) > rules.maxPlay[pos]) errors.push(`Starting XI allows at most ${rules.maxPlay[pos]} ${pos}.`);
  }
  if (!starting.includes(lineup.captain)) errors.push("Captain must be in the starting XI.");
  if (!starting.includes(lineup.viceCaptain)) errors.push("Vice-captain must be in the starting XI.");
  if (lineup.captain === lineup.viceCaptain) errors.push("Captain and vice-captain must differ.");
  return { valid: errors.length === 0, errors };
}
