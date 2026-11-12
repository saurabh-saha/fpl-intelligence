import path from "node:path";
import { deriveTeamStats } from "../fpl/normalizer";
import type { Dataset, Fixture, GameweekInfo, Player, Pos, Rules, Scoring, Team } from "../fpl/types";
import { readCsvGz } from "./csv";

export const HISTORICAL_DIR = path.join(process.cwd(), "data", "historical");

export interface Row {
  gw: number;
  element: number;
  teamName: string;
  fixture: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  xg: number;
  xa: number;
  xgc: number;
  cs: number;
  gc: number;
  saves: number;
  bonus: number;
  bps: number;
  yellow: number;
  red: number;
  dc: number;
  points: number;
  value: number;
  selected: number;
}

export interface SeasonData {
  season: string;
  hasDc: boolean;
  /** rows per element sorted by (gw, fixture) */
  rows: Map<number, Row[]>;
  info: Map<number, { name: string; pos: Pos }>;
  teams: Record<number, Team>;
  teamIdByName: Map<string, number>;
  fixtures: Fixture[];
  /** outcomes read only AFTER selections are fixed */
  actual: Map<number, Map<number, { points: number; minutes: number }>>;
  gwsWithFixtures: Set<number>;
  maxGw: number;
}

const num = (v: string | undefined) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};
const POS: Record<string, Pos> = { GK: "GKP", GKP: "GKP", DEF: "DEF", MID: "MID", FWD: "FWD" };

export function loadSeason(season: string, dir = HISTORICAL_DIR): SeasonData {
  const gws = readCsvGz(path.join(dir, season, "merged_gw.csv.gz"));
  const fx = readCsvGz(path.join(dir, season, "fixtures.csv.gz"));
  const tm = readCsvGz(path.join(dir, season, "teams.csv.gz"));
  const hasDc = "defensive_contribution" in gws[0];

  const teams: Record<number, Team> = {};
  const teamIdByName = new Map<string, number>();
  for (const t of tm) {
    const id = Number(t.id);
    teams[id] = { id, code: Number(t.code), name: t.name, short: t.short_name, played: 0, goalsFor: 0, goalsAgainst: 0, xGFor: 0, xGAgainst: 0, badgeUrl: "" };
    teamIdByName.set(t.name, id);
  }

  const rows = new Map<number, Row[]>();
  const info = new Map<number, { name: string; pos: Pos }>();
  const actual = new Map<number, Map<number, { points: number; minutes: number }>>();
  let maxGw = 0;
  for (const r of gws) {
    const el = Number(r.element);
    const gw = Number(r.GW);
    maxGw = Math.max(maxGw, gw);
    const row: Row = {
      gw, element: el, teamName: r.team, fixture: Number(r.fixture), minutes: num(r.minutes), starts: num(r.starts), goals: num(r.goals_scored), assists: num(r.assists),
      xg: num(r.expected_goals), xa: num(r.expected_assists), xgc: num(r.expected_goals_conceded), cs: num(r.clean_sheets), gc: num(r.goals_conceded), saves: num(r.saves),
      bonus: num(r.bonus), bps: num(r.bps), yellow: num(r.yellow_cards), red: num(r.red_cards), dc: hasDc ? num(r.defensive_contribution) : 0,
      points: num(r.total_points), value: num(r.value), selected: num(r.selected),
    };
    (rows.get(el) ?? rows.set(el, []).get(el)!).push(row);
    info.set(el, { name: r.name, pos: POS[r.position] ?? "MID" });
    const g = actual.get(gw) ?? actual.set(gw, new Map()).get(gw)!;
    const a = g.get(el) ?? { points: 0, minutes: 0 };
    a.points += row.points;
    a.minutes += row.minutes;
    g.set(el, a);
  }
  for (const list of rows.values()) list.sort((a, b) => a.gw - b.gw || a.fixture - b.fixture);

  const fixtures: Fixture[] = fx.map((f) => ({
    id: Number(f.id),
    event: f.event === "" ? null : Number(f.event),
    teamH: Number(f.team_h),
    teamA: Number(f.team_a),
    kickoff: f.kickoff_time || null,
    finished: f.finished === "True",
    scoreH: f.team_h_score === "" ? null : Number(f.team_h_score),
    scoreA: f.team_a_score === "" ? null : Number(f.team_a_score),
    diffH: num(f.team_h_difficulty) || 3,
    diffA: num(f.team_a_difficulty) || 3,
  }));
  const gwsWithFixtures = new Set(fixtures.filter((f) => f.event !== null).map((f) => f.event as number));
  return { season, hasDc, rows, info, teams, teamIdByName, fixtures, actual, gwsWithFixtures, maxGw };
}

/** FPL scoring table. Defensive-contribution points exist only from 2025/26. */
export function scoringFor(hasDc: boolean): Scoring {
  return {
    longPlay: 2,
    shortPlay: 1,
    goalsScored: { GKP: 10, DEF: 6, MID: 5, FWD: 4 },
    assists: 3,
    cleanSheets: { GKP: 4, DEF: 4, MID: 1, FWD: 0 },
    goalsConceded: { GKP: -1, DEF: -1, MID: 0, FWD: 0 },
    saves: 1,
    bonus: 1,
    yellowCards: -1,
    redCards: -3,
    defensiveContribution: { GKP: 0, DEF: hasDc ? 2 : 0, MID: hasDc ? 2 : 0, FWD: hasDc ? 2 : 0 },
  };
}

export const RULES: Rules = {
  squadSize: 15, startingSize: 11, teamLimit: 3, budgetTenths: 1000,
  quota: { GKP: 2, DEF: 5, MID: 5, FWD: 3 }, minPlay: { GKP: 1, DEF: 3, MID: 2, FWD: 1 }, maxPlay: { GKP: 1, DEF: 5, MID: 5, FWD: 3 },
  freeTransfersPerGw: 1, maxFreeTransfers: 5, transferHit: 4, sellOnFee: 0.5,
};

export type AvailabilityMode = "recent-minutes" | "none";

export interface PitOptions {
  /** how doubtful players are inferred: from PAST minutes only, or not at all (everyone available) */
  availability: AvailabilityMode;
}

/**
 * The dataset a manager could have built at the deadline of gameweek `t`: ONLY rows with gw < t,
 * fixtures finished before t, prices of the previous gameweek. Nothing from gameweek t onwards is read
 * except the fixture list (which gameweeks teams play), see docs for that caveat.
 */
export function pointInTime(sd: SeasonData, t: number, opts: PitOptions = { availability: "recent-minutes" }): Dataset {
  const events: GameweekInfo[] = Array.from({ length: 38 }, (_, i) => {
    const id = i + 1;
    const first = sd.fixtures.filter((f) => f.event === id && f.kickoff).map((f) => f.kickoff as string).sort()[0];
    return { id, name: `Gameweek ${id}`, deadline: first ?? "", finished: id < t, isCurrent: id === t - 1, isNext: id === t };
  });
  const fixtures: Fixture[] = sd.fixtures.map((f) => ({ ...f, finished: f.finished && f.event !== null && f.event < t }));
  const teams: Record<number, Team> = JSON.parse(JSON.stringify(sd.teams));

  // each club's last two finished fixtures (for the recent-minutes availability proxy)
  const lastTwo = new Map<number, number[]>();
  const done = fixtures.filter((f) => f.finished).sort((a, b) => (a.event! - b.event!) || (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
  for (const f of done) for (const tid of [f.teamH, f.teamA]) lastTwo.set(tid, [...(lastTwo.get(tid) ?? []), f.id].slice(-2));

  // managers at t-1 = sum of `selected` / 15, so ownership % is derivable without any external number
  let selectedSum = 0;
  for (const list of sd.rows.values()) {
    const r = [...list].reverse().find((x) => x.gw === t - 1);
    if (r) selectedSum += r.selected;
  }
  const managers = selectedSum / 15 || 1;

  const players: Player[] = [];
  for (const [el, list] of sd.rows) {
    const prior = list.filter((r) => r.gw < t);
    if (prior.length === 0) continue; // unknown to a manager at this deadline
    const last = prior[prior.length - 1];
    const teamId = sd.teamIdByName.get(last.teamName);
    if (teamId === undefined) continue;
    const s = (f: (r: Row) => number) => prior.reduce((a, r) => a + f(r), 0);
    const minutes = s((r) => r.minutes);
    const nineties = minutes / 90;
    const per90 = (v: number) => (nineties > 0 ? v / nineties : 0);
    const xG = s((r) => r.xg);
    const xA = s((r) => r.xa);
    const played = prior.filter((r) => r.minutes > 0);
    const recent = played.slice(-3);
    const points = s((r) => r.points);
    let status = "a";
    let chanceNext: number | null = null;
    if (opts.availability === "recent-minutes") {
      const f2 = lastTwo.get(teamId) ?? [];
      if (f2.length === 2) {
        const mins = f2.map((fid) => prior.filter((r) => r.fixture === fid).reduce((a, r) => a + r.minutes, 0));
        if (mins[0] === 0 && mins[1] === 0) { status = "d"; chanceNext = 0; }
      }
    }
    const price = last.value;
    const dc = s((r) => r.dc);
    players.push({
      id: el, code: el, webName: sd.info.get(el)!.name, firstName: "", secondName: "", teamId, pos: sd.info.get(el)!.pos,
      costTenths: price, cost: price / 10, totalPoints: points, ppg: played.length ? points / played.length : 0,
      form: recent.length ? recent.reduce((a, r) => a + r.points, 0) / recent.length : 0,
      ownership: (last.selected / managers) * 100, minutes, starts: s((r) => r.starts), goals: s((r) => r.goals), assists: s((r) => r.assists),
      xG, xA, xGI: xG + xA, xG90: per90(xG), xA90: per90(xA), xGI90: per90(xG + xA),
      cleanSheets: s((r) => r.cs), goalsConceded: s((r) => r.gc), xGC: s((r) => r.xgc), saves: s((r) => r.saves), bonus: s((r) => r.bonus), bps: s((r) => r.bps),
      influence: 0, creativity: 0, threat: 0, ict: 0, defContrib: dc, defContrib90: per90(dc), yellow: s((r) => r.yellow), red: s((r) => r.red),
      chanceNext, status, news: "", penaltiesOrder: null, freekicksOrder: null, cornersOrder: null, photoUrl: "",
    });
  }
  deriveTeamStats(teams, fixtures, players);
  return { players, teams, events, fixtures, scoring: scoringFor(sd.hasDc), rules: RULES, chips: [], fetchedAt: `historical:${sd.season}:GW${t}`, source: "sample", stale: false };
}

/** Post-hoc rotation level of a gameweek: share of regular starters (>= 70% of starts so far) who played < 60 minutes. Used ONLY to classify periods. */
export function rotationIndex(sd: SeasonData, g: number): number {
  if (g < 6) return NaN;
  let regulars = 0;
  let rotated = 0;
  for (const [el, list] of sd.rows) {
    const prior = list.filter((r) => r.gw < g);
    if (prior.length < 5) continue;
    const starts = prior.reduce((a, r) => a + r.starts, 0);
    if (starts / prior.length < 0.7) continue;
    const now = sd.actual.get(g)?.get(el);
    if (!now) continue;
    regulars++;
    if (now.minutes < 60) rotated++;
  }
  return regulars ? rotated / regulars : NaN;
}

export interface Quality { ok: boolean; reason?: string }

/**
 * Data-quality gate on the HISTORY a manager would have had at deadline `t` (gameweeks < t only):
 * every earlier gameweek must carry `starts` (>= 80% of 60+ minute rows) and xG/xA (>= 40% of played rows).
 * The model's start probability and attacking rates are meaningless otherwise, so such windows are skipped, not patched.
 */
export function historyQuality(sd: SeasonData, t: number): Quality {
  const by = new Map<number, { long: number; started: number; played: number; xg: number }>();
  for (const list of sd.rows.values())
    for (const r of list) {
      if (r.gw >= t || r.minutes <= 0) continue;
      const g = by.get(r.gw) ?? by.set(r.gw, { long: 0, started: 0, played: 0, xg: 0 }).get(r.gw)!;
      g.played++;
      if (r.xg > 0 || r.xa > 0) g.xg++;
      if (r.minutes >= 60) { g.long++; if (r.starts > 0) g.started++; }
    }
  const badStarts: number[] = [];
  const badXg: number[] = [];
  for (const [gw, g] of by) {
    if (g.long && g.started / g.long < 0.8) badStarts.push(gw);
    if (g.played && g.xg / g.played < 0.4) badXg.push(gw);
  }
  if (badStarts.length || badXg.length) {
    const f = (a: number[]) => `GW${Math.min(...a)}-${Math.max(...a)} (${a.length})`;
    return { ok: false, reason: `data-quality gate: ${badStarts.length ? `starts missing in ${f(badStarts)}` : ""}${badStarts.length && badXg.length ? "; " : ""}${badXg.length ? `xG/xA missing in ${f(badXg)}` : ""}` };
  }
  return { ok: true };
}
