import type { Dataset, Fixture, FixtureInfo, Team } from "../fpl/types";

/** Home advantage multipliers on attacking output (average ~1.0). */
export const HOME_ATTACK = 1.1;
export const AWAY_ATTACK = 0.9;

export interface LeagueContext {
  /** league mean goals per team per game */
  goalsPerGame: number;
  /** mean xG per team per game */
  xGPerGame: number;
}

/** Fixtures for one team in one gameweek (0 = blank, 2+ = double). */
export function fixturesForTeam(fixtures: Fixture[], teams: Record<number, Team>, teamId: number, gw: number): FixtureInfo[] {
  const out: FixtureInfo[] = [];
  for (const f of fixtures) {
    if (f.event !== gw) continue;
    if (f.teamH !== teamId && f.teamA !== teamId) continue;
    const home = f.teamH === teamId;
    const oppId = home ? f.teamA : f.teamH;
    out.push({
      fixtureId: f.id,
      oppId,
      oppShort: teams[oppId]?.short ?? "?",
      home,
      difficulty: home ? f.diffH : f.diffA,
      kickoff: f.kickoff,
    });
  }
  return out.sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
}

export function leagueContext(ds: Pick<Dataset, "teams">): LeagueContext {
  let games = 0;
  let gf = 0;
  let xg = 0;
  for (const t of Object.values(ds.teams)) {
    games += t.played;
    gf += t.goalsFor;
    xg += t.xGFor;
  }
  return {
    goalsPerGame: games > 0 ? gf / games : 1.4,
    xGPerGame: games > 0 && xg > 0 ? xg / games : 1.4,
  };
}

const SHRINK_GAMES = 4;

/** Goals the team scores per game, blending actual goals and xG, shrunk to league mean for small samples. */
export function attackRate(t: Team, lg: LeagueContext): number {
  if (t.played === 0) return lg.goalsPerGame;
  const raw = 0.5 * (t.goalsFor / t.played) + 0.5 * (t.xGFor / t.played);
  return (raw * t.played + lg.goalsPerGame * SHRINK_GAMES) / (t.played + SHRINK_GAMES);
}

/** Goals the team concedes per game, blending actual and expected goals against. */
export function defenceRate(t: Team, lg: LeagueContext): number {
  if (t.played === 0) return lg.goalsPerGame;
  const raw = 0.5 * (t.goalsAgainst / t.played) + 0.5 * (t.xGAgainst / t.played);
  return (raw * t.played + lg.goalsPerGame * SHRINK_GAMES) / (t.played + SHRINK_GAMES);
}

/**
 * Multiplier on a player's attacking output given this fixture.
 * >1 means the opponent concedes more than the league average. Dampened to avoid overreacting.
 */
export function attackMultiplier(opp: Team, home: boolean, lg: LeagueContext): number {
  const weakness = defenceRate(opp, lg) / lg.goalsPerGame;
  return Math.pow(weakness, 0.8) * (home ? HOME_ATTACK : AWAY_ATTACK);
}

/** Expected goals the player's team concedes in this fixture (drives clean sheets, saves). */
export function expectedGoalsConceded(own: Team, opp: Team, home: boolean, lg: LeagueContext): number {
  const oppAttack = attackRate(opp, lg) / lg.goalsPerGame;
  const ownDefence = defenceRate(own, lg) / lg.goalsPerGame;
  const venue = home ? 1 / HOME_ATTACK : 1 / AWAY_ATTACK;
  return lg.goalsPerGame * Math.sqrt(oppAttack * ownDefence) * Math.pow(venue, 1);
}

/** Opponent's attacking threat relative to league mean (for saves). */
export function opponentAttackRatio(opp: Team, lg: LeagueContext): number {
  return attackRate(opp, lg) / lg.goalsPerGame;
}

/** Fixture difficulty 1 (easy) .. 5 (hard) averaged across fixtures; 0 if blank. */
export function averageDifficulty(fx: FixtureInfo[]): number {
  if (fx.length === 0) return 0;
  return fx.reduce((s, f) => s + f.difficulty, 0) / fx.length;
}
