import { describe, expect, it } from "vitest";
import { projectAll } from "@/lib/analytics/playerScoring";
import { optimizeSquad, OptimizerError } from "@/lib/optimizer/squadOptimizer";
import { bestLineup, lineupExpectedPoints } from "@/lib/optimizer/formationOptimizer";
import { pickCaptains } from "@/lib/optimizer/captainSelector";
import { allFormations, formationValid, validateLineup, validateSquad } from "@/lib/optimizer/validation";
import { evaluateSquad, findAlternatives } from "@/lib/optimizer/alternatives";
import type { Mode, Preferences } from "@/lib/fpl/types";
import { NEXT_GW, sampleDataset } from "./helpers";

const ds = sampleDataset();
const byId = new Map(ds.players.map((p) => [p.id, p]));
const run = (prefs: Preferences, gw = NEXT_GW) => {
  const { byId: proj } = projectAll(ds, gw, prefs);
  return { proj, ...optimizeSquad(ds, proj, prefs) };
};

describe("validation", () => {
  it("enumerates exactly the legal FPL formations", () => {
    const f = allFormations(ds.rules).map((x) => x.join("-")).sort();
    expect(f).toEqual(["3-4-3", "3-5-2", "4-3-3", "4-4-2", "4-5-1", "5-2-3", "5-3-2", "5-4-1"].sort());
    expect(formationValid(2, 5, 3, ds.rules)).toBe(false);
    expect(formationValid(3, 4, 4, ds.rules)).toBe(false);
  });

  it("rejects squads that break club limit, quota, size, duplicates or budget", () => {
    const { result } = run({ mode: "balanced" });
    const ok = result.squad;
    expect(validateSquad(ok, byId, ds.rules).valid).toBe(true);
    expect(validateSquad(ok.slice(1), byId, ds.rules).valid).toBe(false);
    expect(validateSquad([...ok.slice(1), ok[1]], byId, ds.rules).errors.join()).toMatch(/duplicate/);
    expect(validateSquad(ok, byId, ds.rules, 500).errors.join()).toMatch(/Over budget/);

    // four players from one club
    const club = ds.players.filter((p) => p.pos === "MID").reduce<Record<number, number[]>>((m, p) => ((m[p.teamId] ??= []).push(p.id), m), {});
    const bigClub = Object.values(club).find((v) => v.length >= 4)!;
    const squad = [...ok];
    const midIdx = squad.map((id, i) => (byId.get(id)!.pos === "MID" ? i : -1)).filter((i) => i >= 0);
    bigClub.slice(0, 4).forEach((id, k) => (squad[midIdx[k]] = id));
    expect(validateSquad(squad, byId, ds.rules).errors.join()).toMatch(/per club/);
  });
});

describe("squad optimiser", () => {
  const modes: Mode[] = ["balanced", "safe", "aggressive"];
  for (const mode of modes) {
    it(`returns a fully valid squad, XI, bench and captains in ${mode} mode`, () => {
      const { result, proj } = run({ mode });
      expect(validateSquad(result.squad, byId, ds.rules).valid).toBe(true);
      expect(validateLineup(result, result.squad, byId, ds.rules).valid).toBe(true);
      expect(result.totalCostTenths).toBeLessThanOrEqual(1000);
      expect(result.remainingTenths).toBe(1000 - result.totalCostTenths);
      expect(result.starting).toHaveLength(11);
      expect(result.bench).toHaveLength(4);
      // bench keeper first, then outfield
      expect(byId.get(result.bench[0])!.pos).toBe("GKP");
      expect(result.expectedPoints).toBeGreaterThan(40);
      expect(proj.get(result.captain)!.ep).toBeGreaterThanOrEqual(Math.max(...result.starting.map((id) => proj.get(id)!.ep)) - 1e-9);
    });
  }

  it("is deterministic", () => {
    const a = run({ mode: "balanced" }).result;
    const b = run({ mode: "balanced" }).result;
    expect(a).toEqual(b);
  });

  it("is optimal vs a strong greedy baseline and vs highest-points-per-game selection", () => {
    const { result, proj } = run({ mode: "balanced" });
    // baseline: best valid squad by season points-per-game (greedy with same constraints)
    const baselineProj = new Map(proj);
    for (const p of ds.players) baselineProj.set(p.id, { ...proj.get(p.id)!, ep: p.ppg, score: p.ppg });
    const base = optimizeSquad(ds, baselineProj, { mode: "balanced" }).result;
    const baseEp = lineupExpectedPoints(bestLineup(base.squad.map((i) => byId.get(i)!), proj, ds.rules), proj);
    const oursEp = lineupExpectedPoints(bestLineup(result.squad.map((i) => byId.get(i)!), proj, ds.rules), proj);
    expect(oursEp).toBeGreaterThanOrEqual(baseEp - 1e-9);
  });

  it("respects a custom budget and never exceeds it", () => {
    const { result } = run({ mode: "balanced", budgetTenths: 900 });
    expect(result.totalCostTenths).toBeLessThanOrEqual(900);
    const full = run({ mode: "balanced" }).result;
    expect(result.expectedPoints).toBeLessThanOrEqual(full.expectedPoints + 1e-9);
  });

  it("clamps budgets above the official £100m", () => {
    const { result, budgetTenths } = run({ mode: "balanced", budgetTenths: 5000 });
    expect(budgetTenths).toBe(1000);
    expect(result.totalCostTenths).toBeLessThanOrEqual(1000);
  });

  it("honours a preferred formation", () => {
    for (const formation of ["3-5-2", "4-4-2", "5-3-2"]) {
      const { result } = run({ mode: "balanced", formation });
      expect(result.formation).toBe(formation);
      expect(validateLineup(result, result.squad, byId, ds.rules).valid).toBe(true);
    }
  });

  it("rejects malformed formations", () => {
    const { byId: proj } = projectAll(ds, NEXT_GW);
    expect(() => optimizeSquad(ds, proj, { mode: "balanced", formation: "9-9-9x" })).toThrow(OptimizerError);
  });

  it("enforces a maximum ownership cap", () => {
    const { result } = run({ mode: "balanced", maxOwnership: 15 });
    for (const id of result.squad) expect(byId.get(id)!.ownership).toBeLessThanOrEqual(15);
    expect(validateSquad(result.squad, byId, ds.rules).valid).toBe(true);
  });

  it("reports infeasible constraints instead of returning an invalid squad", () => {
    const { byId: proj } = projectAll(ds, NEXT_GW);
    expect(() => optimizeSquad(ds, proj, { mode: "balanced", budgetTenths: 400 })).toThrow(OptimizerError);
  });

  it("never selects unavailable players", () => {
    const { result } = run({ mode: "balanced" });
    for (const id of result.squad) expect(["u", "s", "n"]).not.toContain(byId.get(id)!.status);
  });

  it("differential mode lowers average ownership of the squad", () => {
    const avg = (ids: number[]) => ids.reduce((s, id) => s + byId.get(id)!.ownership, 0) / ids.length;
    const bal = run({ mode: "balanced" }).result;
    const agg = run({ mode: "aggressive", differential: 1 }).result;
    expect(avg(agg.squad)).toBeLessThan(avg(bal.squad));
  });

  it("works for every upcoming gameweek", () => {
    for (const gw of [11, 12, 15, 20, 38]) {
      const { result } = run({ mode: "balanced" }, gw);
      expect(validateSquad(result.squad, byId, ds.rules).valid, `GW${gw}`).toBe(true);
    }
  });

  it("fast enough for interactive use", () => {
    const t0 = Date.now();
    run({ mode: "balanced" });
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe("lineup + captaincy", () => {
  const { result, proj } = run({ mode: "balanced" });
  const squad = result.squad.map((i) => byId.get(i)!);

  it("picks the best formation for any fixed squad", () => {
    const l = bestLineup(squad, proj, ds.rules);
    const totals = allFormations(ds.rules).map(([d, m, f]) => {
      const by = (pos: string) => squad.filter((p) => p.pos === pos).map((p) => proj.get(p.id)!.score).sort((a, b) => b - a);
      const gk = by("GKP")[0];
      const sum = (a: number[], n: number) => a.slice(0, n).reduce((s, v) => s + v, 0);
      return gk + sum(by("DEF"), d) + sum(by("MID"), m) + sum(by("FWD"), f);
    });
    const best = Math.max(...totals);
    const got = l.starting.reduce((s, id) => s + proj.get(id)!.score, 0);
    expect(got).toBeCloseTo(best, 6);
  });

  it("vice-captain differs from captain and prefers reliable starters", () => {
    const { captain, viceCaptain } = pickCaptains(result.starting, proj, byId);
    expect(captain).not.toBe(viceCaptain);
    expect(proj.get(viceCaptain)!.startProb).toBeGreaterThanOrEqual(0.8);
  });

  it("captain counts double in squad expected points", () => {
    const sum = result.starting.reduce((s, id) => s + proj.get(id)!.ep, 0);
    expect(result.expectedPoints).toBeCloseTo(sum + proj.get(result.captain)!.ep, 1);
  });
});

describe("alternatives and replacement", () => {
  const { result, proj } = run({ mode: "balanced" });
  const prefs: Preferences = { mode: "balanced" };

  it("only offers same-position replacements that keep the squad legal", () => {
    for (const outId of [result.starting[1], result.starting[6], result.bench[0]]) {
      const { alternatives } = findAlternatives(ds, proj, result.squad, outId, prefs);
      expect(alternatives.length).toBeGreaterThan(0);
      for (const a of alternatives) {
        expect(byId.get(a.playerId)!.pos).toBe(byId.get(outId)!.pos);
        const next = result.squad.map((id) => (id === outId ? a.playerId : id));
        expect(validateSquad(next, byId, ds.rules).valid).toBe(true);
        expect(result.squad).not.toContain(a.playerId);
      }
    }
  });

  it("reports an accurate expected-points delta and recalculates after a swap", () => {
    const outId = result.starting[3];
    const { alternatives, current } = findAlternatives(ds, proj, result.squad, outId, prefs);
    const alt = alternatives[Math.min(5, alternatives.length - 1)];
    const next = result.squad.map((id) => (id === outId ? alt.playerId : id));
    const re = evaluateSquad(ds, proj, next, prefs);
    expect(re.expectedPoints - current.expectedPoints).toBeCloseTo(alt.deltaEp, 2);
    expect(alt.remainingTenths).toBe(re.remainingTenths);
    expect(validateLineup(re, next, byId, ds.rules).valid).toBe(true);
  });

  it("refuses a swap that would break the club limit", () => {
    // find a club with 3 players in the squad, then the alternatives must never add a 4th
    const counts = new Map<number, number>();
    result.squad.forEach((id) => counts.set(byId.get(id)!.teamId, (counts.get(byId.get(id)!.teamId) ?? 0) + 1));
    const full = [...counts].find(([, n]) => n === 3);
    if (!full) return;
    const outId = result.squad.find((id) => byId.get(id)!.teamId !== full[0])!;
    const { alternatives } = findAlternatives(ds, proj, result.squad, outId, prefs, 800);
    for (const a of alternatives) if (byId.get(a.playerId)!.teamId === full[0]) expect(byId.get(outId)!.teamId).toBe(full[0]);
  });

  it("excludes alternatives that blow the budget", () => {
    const outId = result.starting.find((id) => byId.get(id)!.pos === "DEF")!;
    const { alternatives } = findAlternatives(ds, proj, result.squad, outId, { mode: "balanced", budgetTenths: result.totalCostTenths });
    for (const a of alternatives) expect(a.remainingTenths).toBeGreaterThanOrEqual(0);
  });

  it("errors when the player is not in the squad", () => {
    expect(() => findAlternatives(ds, proj, result.squad, 999999, prefs)).toThrow();
  });

  it("rejects an invalid hand-edited squad", () => {
    expect(() => evaluateSquad(ds, proj, result.squad.slice(0, 14), prefs)).toThrow();
  });
});
