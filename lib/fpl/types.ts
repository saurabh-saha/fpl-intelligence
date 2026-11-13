/** Normalised domain types. The UI and engines only ever see these, never the raw FPL payload. */

export type Pos = "GKP" | "DEF" | "MID" | "FWD";
export const POSITIONS: Pos[] = ["GKP", "DEF", "MID", "FWD"];
export const POS_BY_TYPE: Record<number, Pos> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

export interface Player {
  id: number;
  code: number;
  webName: string;
  firstName: string;
  secondName: string;
  teamId: number;
  pos: Pos;
  /** price in tenths of a million (FPL native unit, avoids float error) */
  costTenths: number;
  cost: number;
  totalPoints: number;
  ppg: number;
  form: number;
  ownership: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  xG: number;
  xA: number;
  xGI: number;
  xG90: number;
  xA90: number;
  xGI90: number;
  cleanSheets: number;
  goalsConceded: number;
  xGC: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: number;
  creativity: number;
  threat: number;
  ict: number;
  defContrib: number;
  defContrib90: number;
  yellow: number;
  red: number;
  chanceNext: number | null;
  status: string;
  news: string;
  /** when FPL last changed the news text (ISO), if the API provides it */
  newsAdded?: string | null;
  penaltiesOrder: number | null;
  freekicksOrder: number | null;
  cornersOrder: number | null;
  photoUrl: string;
}

export interface Team {
  id: number;
  code: number;
  name: string;
  short: string;
  /** derived from finished fixtures */
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  /** derived from player aggregates */
  xGFor: number;
  xGAgainst: number;
  badgeUrl: string;
}

export interface GameweekInfo {
  id: number;
  name: string;
  deadline: string;
  finished: boolean;
  isCurrent: boolean;
  isNext: boolean;
}

export interface Scoring {
  longPlay: number;
  shortPlay: number;
  goalsScored: Record<Pos, number>;
  assists: number;
  cleanSheets: Record<Pos, number>;
  goalsConceded: Record<Pos, number>;
  saves: number;
  bonus: number;
  yellowCards: number;
  redCards: number;
  defensiveContribution: Record<Pos, number>;
}

export interface Rules {
  squadSize: number;
  startingSize: number;
  teamLimit: number;
  budgetTenths: number;
  quota: Record<Pos, number>;
  minPlay: Record<Pos, number>;
  maxPlay: Record<Pos, number>;
  /** free transfers gained per gameweek */
  freeTransfersPerGw: number;
  /** most free transfers that can be banked (API: 1 + max_extra_free_transfers) */
  maxFreeTransfers: number;
  /** points deducted per transfer beyond the free allowance (official rule; not exposed by the API) */
  transferHit: number;
  /** share of a price rise the manager keeps when selling (API: transfers_sell_on_fee) */
  sellOnFee: number;
}

export type ChipName = "wildcard" | "freehit" | "bboost" | "3xc";

export interface ChipDef {
  id: number;
  name: ChipName;
  /** uses allowed within [start, stop] */
  number: number;
  start: number;
  stop: number;
}

export interface Fixture {
  id: number;
  event: number | null;
  teamH: number;
  teamA: number;
  kickoff: string | null;
  finished: boolean;
  scoreH: number | null;
  scoreA: number | null;
  diffH: number;
  diffA: number;
}

export interface Dataset {
  players: Player[];
  teams: Record<number, Team>;
  events: GameweekInfo[];
  fixtures: Fixture[];
  scoring: Scoring;
  rules: Rules;
  chips: ChipDef[];
  /** ISO time the upstream data was last successfully fetched */
  fetchedAt: string;
  source: "live" | "cache" | "sample";
  stale: boolean;
}

/* ---------- analytics ---------- */

export interface FixtureInfo {
  fixtureId: number;
  oppId: number;
  oppShort: string;
  home: boolean;
  difficulty: number;
  kickoff: string | null;
}

export type Confidence = "high" | "medium" | "low";

export interface Components {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheet: number;
  goalsConceded: number;
  saves: number;
  defContrib: number;
  bonus: number;
  cards: number;
  formAdj: number;
}

export interface Projection {
  playerId: number;
  gw: number;
  ep: number;
  /** ep adjusted by optimisation mode; what the optimiser maximises */
  score: number;
  confidence: Confidence;
  confidenceScore: number;
  startProb: number;
  availability: number;
  expMinutes: number;
  fixtures: FixtureInfo[];
  components: Components;
  warnings: string[];
  reasons: string[];
  /** present only when news intelligence changed this projection; carries the original and adjusted numbers */
  news?: import("../news/types").NewsImpact;
}

export type Mode = "balanced" | "safe" | "aggressive";

export interface Preferences {
  mode: Mode;
  /** budget in tenths of a million; clamped to <= rules budget */
  budgetTenths?: number;
  /** "3-4-3" style, outfield only */
  formation?: string;
  /** 0..1 */
  differential?: number;
  maxOwnership?: number;
  favourFixtureRuns?: boolean;
  /** Wildcard / Free Hit: allow a budget above the initial £100m (team value + bank) */
  overCap?: boolean;
}

export interface Lineup {
  starting: number[];
  bench: number[];
  formation: string;
  captain: number;
  viceCaptain: number;
}

export interface SquadResult extends Lineup {
  squad: number[];
  totalCostTenths: number;
  remainingTenths: number;
  /** captain counts double */
  expectedPoints: number;
}
