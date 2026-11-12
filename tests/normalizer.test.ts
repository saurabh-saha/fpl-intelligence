import { describe, expect, it } from "vitest";
import { nextGameweek, normalizeDataset, normalizePlayer, num, SchemaError } from "@/lib/fpl/normalizer";
import { rawBootstrap, rawFixtures, sampleDataset } from "./helpers";

describe("normalizer", () => {
  it("parses numeric strings defensively", () => {
    expect(num("5.5")).toBe(5.5);
    expect(num(null, 7)).toBe(7);
    expect(num("abc", 1)).toBe(1);
    expect(num(undefined)).toBe(0);
  });

  it("normalises the full bootstrap payload", () => {
    const ds = sampleDataset();
    expect(ds.players.length).toBe(rawBootstrap().elements.length);
    expect(Object.keys(ds.teams)).toHaveLength(20);
    expect(ds.events.length).toBe(38);
  });

  it("reads FPL rules from the API rather than hardcoding them", () => {
    const { rules } = sampleDataset();
    expect(rules.squadSize).toBe(15);
    expect(rules.startingSize).toBe(11);
    expect(rules.teamLimit).toBe(3);
    expect(rules.budgetTenths).toBe(1000);
    expect(rules.quota).toEqual({ GKP: 2, DEF: 5, MID: 5, FWD: 3 });
    expect(rules.minPlay).toEqual({ GKP: 1, DEF: 3, MID: 2, FWD: 1 });
    expect(rules.maxPlay).toEqual({ GKP: 1, DEF: 5, MID: 5, FWD: 3 });
  });

  it("reads the scoring table from game_config.scoring", () => {
    const { scoring } = sampleDataset();
    expect(scoring.goalsScored).toEqual({ GKP: 10, DEF: 6, MID: 5, FWD: 4 });
    expect(scoring.cleanSheets.MID).toBe(1);
    expect(scoring.assists).toBe(3);
    expect(scoring.defensiveContribution.DEF).toBe(2);
  });

  it("keeps prices as integer tenths and a decimal view", () => {
    const raya = sampleDataset().players.find((p) => p.webName === "Raya")!;
    expect(raya.costTenths).toBe(62);
    expect(raya.cost).toBe(6.2);
    expect(raya.pos).toBe("GKP");
  });

  it("tolerates missing optional fields", () => {
    const p = normalizePlayer({ id: 1, team: 2, element_type: 3, web_name: "X" });
    expect(p).not.toBeNull();
    expect(p!.xG).toBe(0);
    expect(p!.chanceNext).toBeNull();
    expect(p!.status).toBe("a");
  });

  it("rejects players with unknown position", () => {
    expect(normalizePlayer({ id: 1, team: 2, element_type: 9 })).toBeNull();
  });

  it("throws a SchemaError for malformed payloads", () => {
    expect(() => normalizeDataset({}, [], { fetchedAt: "", source: "live", stale: false })).toThrow(SchemaError);
    expect(() => normalizeDataset(rawBootstrap(), {} as any, { fetchedAt: "", source: "live", stale: false })).toThrow(SchemaError);
  });

  it("derives team games and goals from finished fixtures", () => {
    const ds = sampleDataset();
    const played = Object.values(ds.teams).map((t) => t.played);
    expect(Math.max(...played)).toBeLessThanOrEqual(10);
    const gf = Object.values(ds.teams).reduce((s, t) => s + t.goalsFor, 0);
    const ga = Object.values(ds.teams).reduce((s, t) => s + t.goalsAgainst, 0);
    expect(gf).toBe(ga);
  });

  it("lands on the API's next gameweek", () => {
    expect(nextGameweek(sampleDataset().events).id).toBe(11);
  });

  it("keeps fixtures with event ids", () => {
    const f = rawFixtures().filter((x: any) => x.event === 11);
    expect(sampleDataset().fixtures.filter((x) => x.event === 11)).toHaveLength(f.length);
  });
});
