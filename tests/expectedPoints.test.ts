import { describe, expect, it } from "vitest";
import { expFloorDiv, minutesModel, normalCdf, poissonPmf, projectPlayer, buildModelContext, shrunkRate } from "@/lib/analytics/expectedPoints";
import { consistencyOf } from "@/lib/analytics/consistency";
import { projectAll } from "@/lib/analytics/playerScoring";
import type { Dataset, Player } from "@/lib/fpl/types";
import { NEXT_GW, sampleDataset } from "./helpers";

const ds = sampleDataset();
const ctx = buildModelContext(ds, NEXT_GW);
const find = (name: string) => ds.players.find((p) => p.webName === name)!;

/** Clone a player and force a fixture so home/away and opponent effects can be isolated. */
function withFixture(ds0: Dataset, teamId: number, oppId: number, home: boolean): Dataset {
  const others = ds0.fixtures.filter((f) => f.event !== NEXT_GW);
  return {
    ...ds0,
    fixtures: [
      ...others,
      { id: 9999, event: NEXT_GW, teamH: home ? teamId : oppId, teamA: home ? oppId : teamId, kickoff: null, finished: false, scoreH: null, scoreA: null, diffH: 3, diffA: 3 },
    ],
  };
}

describe("maths helpers", () => {
  it("poisson pmf sums to ~1", () => {
    let s = 0;
    for (let k = 0; k < 30; k++) s += poissonPmf(k, 2.3);
    expect(s).toBeCloseTo(1, 6);
  });
  it("E[floor(X/2)] is monotonic and bounded", () => {
    expect(expFloorDiv(0, 2)).toBe(0);
    expect(expFloorDiv(2, 2)).toBeGreaterThan(expFloorDiv(1, 2));
    expect(expFloorDiv(1.5, 2)).toBeLessThan(1.5 / 2);
  });
  it("normal cdf", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
  });
  it("shrinks small samples towards the prior", () => {
    const prior = 0.2;
    const small = shrunkRate(3, 90, prior); // 3 goals in 90 minutes
    const big = shrunkRate(30, 900, prior); // same rate over 10 games
    expect(small).toBeLessThan(big);
    expect(small).toBeGreaterThan(prior);
    expect(shrunkRate(0, 0, prior)).toBe(prior);
  });
});

describe("expected points model", () => {
  it("produces finite non-negative projections for every player", () => {
    const { byId } = projectAll(ds, NEXT_GW);
    expect(byId.size).toBe(ds.players.length);
    for (const pr of byId.values()) {
      expect(Number.isFinite(pr.ep)).toBe(true);
      expect(pr.ep).toBeGreaterThanOrEqual(0);
      expect(pr.ep).toBeLessThan(25);
    }
  });

  it("is deterministic", () => {
    const a = projectAll(ds, NEXT_GW).byId.get(find("Haaland").id)!;
    const b = projectAll(ds, NEXT_GW).byId.get(find("Haaland").id)!;
    expect(a).toEqual(b);
  });

  it("gives unavailable players zero", () => {
    const out = ds.players.find((p) => p.status === "u")!;
    expect(projectPlayer(out, ctx).ep).toBe(0);
    expect(projectPlayer(out, ctx).availability).toBe(0);
  });

  it("gives zero points when a team has a blank gameweek", () => {
    const blank = withFixture(ds, 99, 98, true); // nobody else plays in GW11
    const c = buildModelContext({ ...blank, fixtures: blank.fixtures.filter((f) => f.id === 9999) }, NEXT_GW);
    const p = projectPlayer(find("Haaland"), c);
    expect(p.ep).toBe(0);
    expect(p.fixtures).toHaveLength(0);
  });

  it("projects more points at home than away against the same opponent", () => {
    const p = find("Haaland");
    const opp = ds.teams[1].id === p.teamId ? 2 : 1;
    const home = projectPlayer(p, buildModelContext(withFixture(ds, p.teamId, opp, true), NEXT_GW)).ep;
    const away = projectPlayer(p, buildModelContext(withFixture(ds, p.teamId, opp, false), NEXT_GW)).ep;
    expect(home).toBeGreaterThan(away);
  });

  it("projects an attacker higher against a weak defence than a strong one", () => {
    const p = find("Haaland");
    const teams = Object.values(ds.teams).filter((t) => t.id !== p.teamId && t.played > 0);
    const lg = ctx.lg;
    const rate = (t: (typeof teams)[number]) => (t.goalsAgainst / t.played + t.xGAgainst / t.played) / 2;
    const weak = [...teams].sort((a, b) => rate(b) - rate(a))[0];
    const strong = [...teams].sort((a, b) => rate(a) - rate(b))[0];
    expect(rate(weak)).toBeGreaterThan(lg.goalsPerGame * 0.5);
    const vsWeak = projectPlayer(p, buildModelContext(withFixture(ds, p.teamId, weak.id, true), NEXT_GW));
    const vsStrong = projectPlayer(p, buildModelContext(withFixture(ds, p.teamId, strong.id, true), NEXT_GW));
    expect(vsWeak.components.goals).toBeGreaterThan(vsStrong.components.goals);
    expect(vsWeak.ep).toBeGreaterThan(vsStrong.ep);
  });

  it("doubles appearance points in a double gameweek", () => {
    const p = find("Haaland");
    const single = projectPlayer(p, ctx);
    const fx = ds.fixtures.find((f) => f.event === NEXT_GW && (f.teamH === p.teamId || f.teamA === p.teamId))!;
    const dgw: Dataset = { ...ds, fixtures: [...ds.fixtures, { ...fx, id: 8888 }] };
    const dbl = projectPlayer(p, buildModelContext(dgw, NEXT_GW));
    expect(dbl.fixtures).toHaveLength(2);
    expect(dbl.components.appearance).toBeCloseTo(single.components.appearance * 2, 1);
    expect(dbl.ep).toBeGreaterThan(single.ep * 1.8);
  });

  it("uses position-specific scoring from the API (defenders earn more per goal than forwards)", () => {
    const base = find("Haaland");
    const asDef: Player = { ...base, pos: "DEF" };
    const asFwd: Player = { ...base, pos: "FWD" };
    // identical underlying stats -> goal points differ only by the scoring table (6 vs 4) and priors
    const d = projectPlayer(asDef, ctx).components.goals;
    const f = projectPlayer(asFwd, ctx).components.goals;
    expect(d / f).toBeGreaterThan(1.2);
  });

  it("clean-sheet points only go to positions that earn them", () => {
    const { byId } = projectAll(ds, NEXT_GW);
    const fwd = find("Haaland");
    expect(byId.get(fwd.id)!.components.cleanSheet).toBe(0);
    const def = ds.players.find((p) => p.pos === "DEF" && p.minutes > 700)!;
    expect(byId.get(def.id)!.components.cleanSheet).toBeGreaterThan(0.3);
  });

  it("only goalkeepers earn save points", () => {
    const { byId } = projectAll(ds, NEXT_GW);
    const gk = ds.players.find((p) => p.pos === "GKP" && p.minutes > 700)!;
    expect(byId.get(gk.id)!.components.saves).toBeGreaterThan(0);
    expect(byId.get(find("Haaland").id)!.components.saves).toBe(0);
  });

  it("penalises players who rarely start", () => {
    const starter = ds.players.find((p) => p.pos === "MID" && p.starts >= 9 && p.minutes > 800)!;
    const rotation: Player = { ...starter, starts: 1, minutes: 120 };
    expect(minutesModel(rotation, ds.teams[rotation.teamId], NEXT_GW, 11).startProb).toBeLessThan(0.3);
    expect(projectPlayer(rotation, ctx).ep).toBeLessThan(projectPlayer(starter, ctx).ep);
  });

  it("scales by chance of playing", () => {
    const base = ds.players.find((p) => p.pos === "MID" && p.starts >= 9 && p.minutes > 800 && p.status === "a")!;
    const doubtful: Player = { ...base, status: "d", chanceNext: 25 };
    expect(projectPlayer(doubtful, ctx).availability).toBe(0.25);
    expect(projectPlayer(doubtful, ctx).ep).toBeLessThan(projectPlayer(base, ctx).ep * 0.5);
  });

  it("does not count goals and xG as separate scoring events", () => {
    // Doubling actual goals while holding xG fixed moves the rate by at most the 20% realised-goals weight.
    const base = find("Haaland");
    const lucky: Player = { ...base, goals: base.goals * 2 };
    const a = projectPlayer(base, ctx).components.goals;
    const b = projectPlayer(lucky, ctx).components.goals;
    expect(b / a).toBeLessThan(1.25);
  });

  it("attaches a confidence indicator that falls with small samples", () => {
    const veteran = ds.players.find((p) => p.minutes > 850 && p.starts >= 9 && p.status === "a")!;
    const rookie: Player = { ...veteran, minutes: 60, starts: 0 };
    expect(projectPlayer(veteran, ctx).confidence).toBe("high");
    expect(projectPlayer(rookie, ctx).confidence).toBe("low");
  });

  it("explains selections and raises only data-backed warnings", () => {
    const { byId } = projectAll(ds, NEXT_GW);
    const hid = find("Haaland").id;
    expect(byId.get(hid)!.reasons.length).toBeGreaterThan(1);
    const injured = ds.players.find((p) => p.status === "i" && p.news && p.minutes > 300);
    if (injured) {
      const pr = byId.get(injured.id)!;
      expect(pr.warnings.join(" ")).toContain(injured.news);
    }
    const healthy = ds.players.find((p) => p.status === "a" && p.chanceNext === null && p.minutes > 850)!;
    expect(byId.get(healthy.id)!.warnings.join(" ")).not.toMatch(/injur/i);
  });

  it("differential mode lifts low-ownership selection scores but never the projection", () => {
    const bal = projectAll(ds, NEXT_GW, { mode: "balanced" }).byId;
    const agg = projectAll(ds, NEXT_GW, { mode: "aggressive", differential: 1 }).byId;
    const low = ds.players.find((p) => p.ownership < 2 && p.minutes > 600 && p.starts > 6)!;
    expect(agg.get(low.id)!.ep).toBe(bal.get(low.id)!.ep);
    expect(agg.get(low.id)!.score / agg.get(low.id)!.ep).toBeGreaterThan(bal.get(low.id)!.score / bal.get(low.id)!.ep);
  });

  it("fixture-run preference blends later gameweeks into the selection score only", () => {
    const base = projectAll(ds, NEXT_GW).byId;
    const run = projectAll(ds, NEXT_GW, { mode: "balanced", favourFixtureRuns: true }).byId;
    let changed = 0;
    for (const [id, pr] of run) {
      expect(pr.ep).toBe(base.get(id)!.ep);
      if (pr.score !== base.get(id)!.score) changed++;
    }
    expect(changed).toBeGreaterThan(100);
  });
});

describe("consistency", () => {
  const row = (round: number, pts: number, g = 0, a = 0, minutes = 90) => ({ round, total_points: pts, minutes, goals_scored: g, assists: a });
  it("flags one-match hauls", () => {
    const c = consistencyOf([row(1, 2), row(2, 2), row(3, 2), row(4, 17, 3), row(5, 2), row(6, 1)]);
    expect(c.label).toBe("hauls");
    expect(c.haulShare).toBeGreaterThan(0.5);
  });
  it("recognises steady returners", () => {
    const c = consistencyOf([row(1, 6, 1), row(2, 5, 0, 1), row(3, 7, 1), row(4, 2), row(5, 6, 1), row(6, 5, 0, 1)]);
    expect(c.label).toBe("consistent");
  });
  it("returns n/a with too little history", () => {
    expect(consistencyOf([row(1, 5)]).label).toBe("n/a");
  });
});
