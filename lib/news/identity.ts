import type { Dataset, Player } from "../fpl/types";

export const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/[^a-zA-Z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export interface PlayerMatch {
  playerId: number | null;
  confidence: number;
  ambiguous: boolean;
  candidates: number[];
  reason: string;
}

export interface PlayerIndex {
  full: Map<string, number[]>;
  web: Map<string, number[]>;
  surname: Map<string, number[]>;
  players: Map<number, Player>;
  clubAliases: Map<string, number>;
}

const push = (m: Map<string, number[]>, k: string, id: number) => { if (k) m.set(k, [...(m.get(k) ?? []), id]); };

export function buildPlayerIndex(ds: Dataset): PlayerIndex {
  const idx: PlayerIndex = { full: new Map(), web: new Map(), surname: new Map(), players: new Map(), clubAliases: new Map() };
  for (const p of ds.players) {
    idx.players.set(p.id, p);
    push(idx.full, norm(`${p.firstName} ${p.secondName}`), p.id);
    push(idx.web, norm(p.webName), p.id);
    const sn = norm(p.secondName);
    push(idx.surname, sn, id(p));
    for (const part of sn.split(" ")) if (part.length > 3 && part !== sn) push(idx.surname, part, p.id);
  }
  for (const t of Object.values(ds.teams)) {
    idx.clubAliases.set(norm(t.name), t.id);
    idx.clubAliases.set(norm(t.short), t.id);
    idx.clubAliases.set(norm(t.name.replace(/\b(fc|afc|a\.f\.c\.)\b/g, "")), t.id);
  }
  return idx;
}
const id = (p: Player) => p.id;

/** The club named in a text, if exactly one is mentioned. */
export function clubIn(text: string, idx: PlayerIndex): number | null {
  const t = ` ${norm(text)} `;
  const hits = new Set<number>();
  for (const [alias, tid] of idx.clubAliases) if (alias.length >= 4 && t.includes(` ${alias} `)) hits.add(tid);
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Resolve a name from an article to a real FPL player. Never guesses: an ambiguous name is returned with its
 * candidates and `playerId: null`, so it can be reviewed instead of being attached to the wrong player.
 */
export function matchPlayer(name: string, idx: PlayerIndex, clubHint?: number | null): PlayerMatch {
  const n = norm(name);
  if (!n) return { playerId: null, confidence: 0, ambiguous: false, candidates: [], reason: "empty name" };
  const narrow = (ids: number[]) => (clubHint ? ids.filter((i) => idx.players.get(i)?.teamId === clubHint) : ids);
  const tiers: [string, Map<string, number[]>, number][] = [["full name", idx.full, 0.98], ["web name", idx.web, 0.9], ["surname", idx.surname, 0.75]];
  for (const [label, map, conf] of tiers) {
    const ids = map.get(n);
    if (!ids?.length) continue;
    const uniq = [...new Set(ids)];
    const byClub = narrow(uniq);
    if (uniq.length === 1) return { playerId: uniq[0], confidence: conf, ambiguous: false, candidates: uniq, reason: `unique ${label} match` };
    if (byClub.length === 1) return { playerId: byClub[0], confidence: conf - 0.1, ambiguous: false, candidates: uniq, reason: `${label} match resolved by club` };
    return { playerId: null, confidence: 0, ambiguous: true, candidates: byClub.length ? byClub : uniq, reason: `${uniq.length} players share the ${label} "${name}"` };
  }
  // last token (e.g. "Bukayo Saka" typed as "B. Saka")
  const last = n.split(" ").pop()!;
  if (last !== n && last.length > 2) {
    const m = matchPlayer(last, idx, clubHint);
    if (m.playerId !== null) return { ...m, confidence: Math.min(m.confidence, 0.7), reason: `matched on surname "${last}"` };
    if (m.ambiguous) return m;
  }
  return { playerId: null, confidence: 0, ambiguous: false, candidates: [], reason: "no player with that name" };
}
