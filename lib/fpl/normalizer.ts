import {
  POS_BY_TYPE,
  POSITIONS,
  type ChipDef,
  type Dataset,
  type Fixture,
  type GameweekInfo,
  type Player,
  type Pos,
  type Rules,
  type Scoring,
  type Team,
} from "./types";

type Raw = Record<string, any>;

export class SchemaError extends Error {}

/** Parse numeric-ish values ("5.5", 5.5, null) defensively. */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

const posRec = (get: (p: Pos) => number): Record<Pos, number> => ({
  GKP: get("GKP"),
  DEF: get("DEF"),
  MID: get("MID"),
  FWD: get("FWD"),
});

export function normalizePlayer(e: Raw): Player | null {
  const pos = POS_BY_TYPE[e.element_type];
  if (!pos || typeof e.id !== "number" || typeof e.team !== "number") return null;
  const minutes = num(e.minutes);
  const nineties = minutes / 90;
  const per90 = (total: number) => (nineties > 0 ? total / nineties : 0);
  const xG = num(e.expected_goals);
  const xA = num(e.expected_assists);
  return {
    id: e.id,
    code: num(e.code),
    webName: String(e.web_name ?? ""),
    firstName: String(e.first_name ?? ""),
    secondName: String(e.second_name ?? ""),
    teamId: e.team,
    pos,
    costTenths: num(e.now_cost),
    cost: num(e.now_cost) / 10,
    totalPoints: num(e.total_points),
    ppg: num(e.points_per_game),
    form: num(e.form),
    ownership: num(e.selected_by_percent),
    minutes,
    starts: num(e.starts),
    goals: num(e.goals_scored),
    assists: num(e.assists),
    xG,
    xA,
    xGI: num(e.expected_goal_involvements, xG + xA),
    xG90: e.expected_goals_per_90 != null ? num(e.expected_goals_per_90) : per90(xG),
    xA90: e.expected_assists_per_90 != null ? num(e.expected_assists_per_90) : per90(xA),
    xGI90:
      e.expected_goal_involvements_per_90 != null
        ? num(e.expected_goal_involvements_per_90)
        : per90(xG + xA),
    cleanSheets: num(e.clean_sheets),
    goalsConceded: num(e.goals_conceded),
    xGC: num(e.expected_goals_conceded),
    saves: num(e.saves),
    bonus: num(e.bonus),
    bps: num(e.bps),
    influence: num(e.influence),
    creativity: num(e.creativity),
    threat: num(e.threat),
    ict: num(e.ict_index),
    defContrib: num(e.defensive_contribution),
    defContrib90:
      e.defensive_contribution_per_90 != null
        ? num(e.defensive_contribution_per_90)
        : per90(num(e.defensive_contribution)),
    yellow: num(e.yellow_cards),
    red: num(e.red_cards),
    chanceNext: nullableNum(e.chance_of_playing_next_round),
    status: String(e.status ?? "a"),
    news: String(e.news ?? ""),
    newsAdded: e.news_added ? String(e.news_added) : null,
    penaltiesOrder: nullableNum(e.penalties_order),
    freekicksOrder: nullableNum(e.direct_freekicks_order),
    cornersOrder: nullableNum(e.corners_and_indirect_freekicks_order),
    photoUrl: `https://resources.premierleague.com/premierleague25/photos/players/110x140/${num(e.code)}.png`,
  };
}

export function normalizeFixtures(raw: unknown): Fixture[] {
  if (!Array.isArray(raw)) throw new SchemaError("fixtures payload is not an array");
  return raw
    .filter((f: Raw) => typeof f.team_h === "number" && typeof f.team_a === "number")
    .map((f: Raw) => ({
      id: f.id,
      event: typeof f.event === "number" ? f.event : null,
      teamH: f.team_h,
      teamA: f.team_a,
      kickoff: f.kickoff_time ?? null,
      finished: Boolean(f.finished || f.finished_provisional),
      scoreH: nullableNum(f.team_h_score),
      scoreA: nullableNum(f.team_a_score),
      diffH: num(f.team_h_difficulty, 3),
      diffA: num(f.team_a_difficulty, 3),
    }));
}

function normalizeScoring(s: Raw | undefined): Scoring {
  // Falls back to the long-standing FPL values if the API ever omits the block.
  const g = (k: string, d: Record<Pos, number>) =>
    s?.[k] ? posRec((p) => num(s[k][p], d[p])) : d;
  return {
    longPlay: num(s?.long_play, 2),
    shortPlay: num(s?.short_play, 1),
    goalsScored: g("goals_scored", { GKP: 10, DEF: 6, MID: 5, FWD: 4 }),
    assists: num(s?.assists, 3),
    cleanSheets: g("clean_sheets", { GKP: 4, DEF: 4, MID: 1, FWD: 0 }),
    goalsConceded: g("goals_conceded", { GKP: -1, DEF: -1, MID: 0, FWD: 0 }),
    saves: num(s?.saves, 1),
    bonus: num(s?.bonus, 1),
    yellowCards: num(s?.yellow_cards, -1),
    redCards: num(s?.red_cards, -3),
    defensiveContribution: g("defensive_contribution", { GKP: 0, DEF: 2, MID: 2, FWD: 2 }),
  };
}

function normalizeRules(rules: Raw | undefined, types: Raw[]): Rules {
  const by = (id: number) => types.find((t) => t.id === id) ?? {};
  const quota = posRec((p) => num(by(POSITIONS.indexOf(p) + 1).squad_select, { GKP: 2, DEF: 5, MID: 5, FWD: 3 }[p]));
  const minPlay = posRec((p) => num(by(POSITIONS.indexOf(p) + 1).squad_min_play, { GKP: 1, DEF: 3, MID: 2, FWD: 1 }[p]));
  const maxPlay = posRec((p) => num(by(POSITIONS.indexOf(p) + 1).squad_max_play, { GKP: 1, DEF: 5, MID: 5, FWD: 3 }[p]));
  return {
    squadSize: num(rules?.squad_squadsize, 15),
    startingSize: num(rules?.squad_squadplay, 11),
    teamLimit: num(rules?.squad_team_limit, 3),
    budgetTenths: num(rules?.squad_total_spend, 1000),
    quota,
    minPlay,
    maxPlay,
    freeTransfersPerGw: 1,
    maxFreeTransfers: 1 + num(rules?.max_extra_free_transfers, 4),
    transferHit: 4,
    sellOnFee: num(rules?.transfers_sell_on_fee, 0.5),
  };
}

const CHIP_NAMES = ["wildcard", "freehit", "bboost", "3xc"];
function normalizeChips(raw: unknown): ChipDef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c: Raw) => CHIP_NAMES.includes(c.name))
    .map((c: Raw) => ({ id: c.id, name: c.name, number: num(c.number, 1), start: num(c.start_event, 1), stop: num(c.stop_event, 38) }));
}

/** Derive per-team season aggregates from finished fixtures and player totals. */
export function deriveTeamStats(teams: Record<number, Team>, fixtures: Fixture[], players: Player[]) {
  for (const t of Object.values(teams)) {
    t.played = 0;
    t.goalsFor = 0;
    t.goalsAgainst = 0;
    t.xGFor = 0;
    t.xGAgainst = 0;
  }
  for (const f of fixtures) {
    if (!f.finished || f.scoreH == null || f.scoreA == null) continue;
    const h = teams[f.teamH];
    const a = teams[f.teamA];
    if (!h || !a) continue;
    h.played++;
    a.played++;
    h.goalsFor += f.scoreH;
    h.goalsAgainst += f.scoreA;
    a.goalsFor += f.scoreA;
    a.goalsAgainst += f.scoreH;
  }
  const topGk: Record<number, Player> = {};
  for (const p of players) {
    const t = teams[p.teamId];
    if (!t) continue;
    t.xGFor += p.xG;
    if (p.pos === "GKP" && (!topGk[p.teamId] || p.minutes > topGk[p.teamId].minutes)) topGk[p.teamId] = p;
  }
  for (const t of Object.values(teams)) {
    const gk = topGk[t.id];
    // The first-choice keeper's xGC over his minutes approximates the team's xGC per game.
    t.xGAgainst = gk && gk.minutes > 0 ? (gk.xGC / gk.minutes) * 90 * t.played : t.goalsAgainst;
  }
}

export function normalizeDataset(
  bootstrap: Raw,
  fixturesRaw: unknown,
  meta: { fetchedAt: string; source: Dataset["source"]; stale: boolean },
): Dataset {
  if (!bootstrap || !Array.isArray(bootstrap.elements) || !Array.isArray(bootstrap.teams) || !Array.isArray(bootstrap.events)) {
    throw new SchemaError("bootstrap-static is missing elements/teams/events");
  }
  const players = bootstrap.elements.map(normalizePlayer).filter((p: Player | null): p is Player => p !== null);
  if (players.length === 0) throw new SchemaError("bootstrap-static contained no usable players");

  const teams: Record<number, Team> = {};
  for (const t of bootstrap.teams as Raw[]) {
    teams[t.id] = {
      id: t.id,
      code: num(t.code),
      name: String(t.name),
      short: String(t.short_name),
      played: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      xGFor: 0,
      xGAgainst: 0,
      badgeUrl: `https://resources.premierleague.com/premierleague/badges/70/t${num(t.code)}.png`,
    };
  }
  const events: GameweekInfo[] = (bootstrap.events as Raw[]).map((e) => ({
    id: e.id,
    name: String(e.name),
    deadline: String(e.deadline_time),
    finished: Boolean(e.finished),
    isCurrent: Boolean(e.is_current),
    isNext: Boolean(e.is_next),
  }));
  const fixtures = normalizeFixtures(fixturesRaw);
  deriveTeamStats(teams, fixtures, players);

  const cfg = bootstrap.game_config ?? {};
  const rules = normalizeRules(cfg.rules ?? bootstrap.game_settings, bootstrap.element_types ?? []);
  const scoring = normalizeScoring(cfg.scoring);
  return { players, teams, events, fixtures, scoring, rules, chips: normalizeChips(bootstrap.chips), ...meta };
}

/** The gameweek the user should land on: the API's "next" event, else the first unfinished one. */
export function nextGameweek(events: GameweekInfo[]): GameweekInfo {
  return (
    events.find((e) => e.isNext) ??
    events.find((e) => !e.finished) ??
    events[events.length - 1]
  );
}
