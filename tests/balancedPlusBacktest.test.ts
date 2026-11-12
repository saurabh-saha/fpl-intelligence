import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectAll } from "@/lib/analytics/playerScoring";
import { loadSeason, historyQuality, pointInTime, type SeasonData } from "@/lib/backtest/historical";
import { MAIN_STRATEGIES, runSeason } from "@/lib/backtest/run";
import { scoreGameweek } from "@/lib/backtest/scoring";
import { blockBootstrapCI, mean, ranks, signTest, tInterval } from "@/lib/backtest/stats";
import { currentConfig, sourceHashes } from "@/lib/backtest/frozen";
import type { Pos } from "@/lib/fpl/types";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";
import { validateSquad } from "@/lib/optimizer/validation";
import { buildHorizon } from "@/lib/season/horizon";
import { balancedPlusValues, optimizeBalancedPlus } from "@/lib/strategies/balancedPlus";
import { buildBalancedPlusDoc, strategyDefinition } from "@/lib/strategies/report";
import { BACKTEST_LIMITATIONS, loadValidationSummary } from "@/lib/strategies/validation";
import { verifyHistoricalManifest } from "@/lib/backtest/manifest";
import { compact, embeddedJson, pdfInfo, textJson } from "./pdfHelpers";
import { NEXT_GW, sampleDataset } from "./helpers";

vi.mock("@/lib/fpl/client", () => ({ getDataset: async () => (await import("./helpers")).sampleDataset(), getElementSummary: async () => null }));

const ds = sampleDataset();

describe("Balanced, Safe and Aggressive remain exactly as before", () => {
  // SHA-256 of the optimiser and projection-engine sources, recorded BEFORE this task started.
  const BEFORE: Record<string, string> = {
    "lib/analytics/consistency.ts": "6d6bdbf7eae0ef5175e40f7785f83350d0b4391259f867a52dbe5828f6628b1a",
    "lib/analytics/expectedPoints.ts": "f2a934c95b1463a3e112cbef9bce33999eb8433fdb24fbf0c0c7856fce4bed61",
    "lib/analytics/fixtureAnalysis.ts": "7f96b612a131c7409efd5a017b1f2195a1ebacc1949da8bb7d0d6daeb859c8f8",
    "lib/analytics/playerScoring.ts": "29e28c0a71f9f1eb78d26a377c05bba1e4684e9e2867f3e0c6dabcba090b008f",
    "lib/optimizer/alternatives.ts": "b48a920f766c4ab562c505f6995c4efbae5ac327d00cf617851d0e6fb4068630",
    "lib/optimizer/captainSelector.ts": "23184f3d875f4306326a38bc35bceefb5fed7e705500375f7ca3d99837fbc938",
    "lib/optimizer/formationOptimizer.ts": "831fb9bc0a08f9d3b8b6be448168170392174382c4d4ec28f2f8e4fcd8fc068e",
    "lib/optimizer/lp-solver.d.ts": "1640c44eabede2a91c1444e097d8435b110c0397f9b3157d31360130b56df55b",
    "lib/optimizer/squadOptimizer.ts": "eddb7dd5a6e66adda655009f89c0f7d7640d246eb5dbee7737d5b9765ae490c9",
    "lib/optimizer/validation.ts": "f586a82f905d48b2b38dd71869093b0bf3a777b42b43d4b98d00babb543d6c36",
  };
  it("the optimiser and projection-engine source files are byte-identical to before the backtest work", () => {
    const now = sourceHashes();
    for (const [f, h] of Object.entries(BEFORE)) expect(now[f], f).toBe(h);
  });
  it("Balanced Plus defaults are unchanged by the new ablation options (pinned GW11 output)", () => {
    const hz = buildHorizon(ds, NEXT_GW);
    const bp = optimizeBalancedPlus(ds, hz);
    expect({ starting: bp.starting, bench: bp.bench, captain: bp.captain, vice: bp.viceCaptain, formation: bp.formation, cost: bp.totalCostTenths, ep: bp.expectedPoints }).toEqual({
      starting: [385, 112, 115, 504, 68, 427, 542, 15, 411, 249, 379], bench: [572, 124, 334, 566], captain: 411, vice: 379, formation: "3-4-3", cost: 999, ep: 55.55,
    });
    const v = balancedPlusValues(ds, hz);
    expect(v.get(385)!.value).toBe(4.02);
    expect(v.get(411)!.value).toBe(5.08);
  });
});

describe("Balanced Plus audit: report text matches behaviour", () => {
  const hz = buildHorizon(ds, NEXT_GW);
  const base = balancedPlusValues(ds, hz);
  const probe = (name: string, mut: (p: any) => void) => {
    const p = ds.players.find((x) => x.webName === name)!;
    const d = { ...ds, players: ds.players.map((x) => { const c = { ...x }; if (c.id === p.id) mut(c); return c; }) };
    const h = buildHorizon(d, NEXT_GW);
    const v = balancedPlusValues(d, h).get(p.id)!;
    return { objective: v.value - base.get(p.id)!.value, displayed: v.ep0 - base.get(p.id)!.ep0 };
  };
  it("objective ignores the player's realised goals/assists and form, but displayed xPts do not", () => {
    const g = probe("Haaland", (p) => (p.goals *= 2));
    expect(Math.abs(g.objective)).toBeLessThan(0.05);
    expect(g.displayed).toBeGreaterThan(0.3);
    const f = probe("Tavernier", (p) => (p.form = 12));
    expect(Math.abs(f.objective)).toBeLessThan(0.02);
    expect(f.displayed).toBeGreaterThan(0.2);
    const a = probe("Van Hecke", (p) => (p.assists += 3));
    expect(Math.abs(a.objective)).toBeLessThan(0.02);
    expect(a.displayed).toBeGreaterThan(0.1);
  });
  it("but the objective DOES still respond to realised bonus, defensive contribution, saves and cards", () => {
    expect(probe("Tavernier", (p) => (p.bonus *= 2)).objective).toBeGreaterThan(0.3);
    expect(probe("Van Hecke", (p) => (p.defContrib *= 2)).objective).toBeGreaterThan(0.5);
    expect(probe("Trafford", (p) => (p.saves *= 2)).objective).toBeGreaterThan(0.4);
    expect(probe("Haaland", (p) => (p.yellow += 3)).objective).toBeLessThan(-0.1);
  });
  it("the strategy definition states exactly this (no over-claiming)", () => {
    const d = strategyDefinition();
    const rules = d.rules.join(" ");
    expect(rules).toMatch(/realised goals and assists are excluded from those two terms/);
    expect(rules).toMatch(/Bonus points, defensive contribution, saves, cards, team goals conceded and minutes\/starts still come from realised data/);
    expect(rules).toMatch(/removed from the objective\. It is NOT removed from the displayed xPts/);
    expect(rules).toMatch(/captaincy is chosen from the displayed xPts/);
    expect(rules).not.toMatch(/realised goals and assists are not used\./);
    expect(d.methodology.objectiveVersusDisplayedXpts).toMatch(/DISPLAYED xPts/);
    expect(d.methodology.realisedDataInObjective).toMatch(/Excluded: the player's own realised goals and assists/);
  });
  it("the PDF explains objective vs displayed xPts per player, and the validation verdict, and stays machine-readable", async () => {
    const hz2 = buildHorizon(ds, NEXT_GW);
    const doc = await buildBalancedPlusDoc(ds, NEXT_GW, hz2);
    const buf = await doc.pdf();
    const info = await pdfInfo(buf);
    const flat = info.text.replace(/\s+/g, " ");
    expect(flat).toContain("What the Balanced Plus objective uses, and what this report displays");
    expect(flat).toContain("Displayed xPts use realised data as follows");
    expect(flat).toContain("Form: Removed from the objective only");
    expect(flat).toContain("Displayed form tilt inside XI xPts (not in the BP objective)");
    const att = embeddedJson(buf);
    expect(att.strategy.playerObjective).toHaveLength(15);
    for (const o of att.strategy.playerObjective) { expect(typeof o.objectiveValue5Gw).toBe("number"); expect(typeof o.displayedXpts5Gw).toBe("number"); }
    expect(att.strategy.methodology.form).toMatch(/objective only/);
    const val = loadValidationSummary();
    if (val.available) {
      expect(flat).toContain("Historical validation (rolling backtest)");
      expect(flat).toContain(val.verdictText!);
      expect(att.strategy.historicalValidation.verdict).toBe(val.verdict);
    }
    expect(textJson(info.text)).toBe(compact(att));
  });
});

describe("historical loader, point-in-time data and leakage", () => {
  let sd: SeasonData;
  beforeAll(() => { sd = loadSeason("2023-24"); }, 60000);
  const K = 12;

  it("maps every team and position", () => {
    for (const list of sd.rows.values()) expect(sd.teamIdByName.has(list[0].teamName), list[0].teamName).toBe(true);
    expect(Object.keys(sd.teams)).toHaveLength(20);
    expect(new Set([...sd.info.values()].map((i) => i.pos))).toEqual(new Set(["GKP", "DEF", "MID", "FWD"]));
  });

  it("the data at deadline k is a function of rounds < k only: corrupting everything from k onwards changes nothing", () => {
    const corrupt: SeasonData = {
      ...sd,
      rows: new Map([...sd.rows].map(([el, l]) => [el, l.map((r) => (r.gw >= K ? { ...r, minutes: 90 - r.minutes, points: 99, xg: 9, xa: 9, goals: 9, assists: 9, value: 40, selected: 1, bonus: 3, starts: 1 - r.starts, saves: 20, dc: 50, yellow: 5 } : r))])),
      actual: new Map([...sd.actual].map(([g, m]) => [g, g >= K ? new Map([...m].map(([el]) => [el, { points: 99, minutes: 0 }])) : m])),
    };
    expect(JSON.stringify(pointInTime(corrupt, K).players)).toBe(JSON.stringify(pointInTime(sd, K).players));
    expect(JSON.stringify(pointInTime(corrupt, K, { availability: "none" }).players)).toBe(JSON.stringify(pointInTime(sd, K, { availability: "none" }).players));
    // selections and the first lineup of the window cannot depend on later information; scored points do
    const a = runSeason({ sd, strategies: MAIN_STRATEGIES, availability: "recent-minutes", firstK: K, lastK: K }).windows[0];
    const b = runSeason({ sd: corrupt, strategies: MAIN_STRATEGIES, availability: "recent-minutes", firstK: K, lastK: K }).windows[0];
    for (const s of MAIN_STRATEGIES) {
      expect(b.strategies[s.id].squad, s.id).toEqual(a.strategies[s.id].squad);
      expect(b.strategies[s.id].gws[0].starting, s.id).toEqual(a.strategies[s.id].gws[0].starting);
      expect(b.strategies[s.id].gws[0].captain, s.id).toBe(a.strategies[s.id].gws[0].captain);
      expect(b.strategies[s.id].points).not.toBe(a.strategies[s.id].points);
    }
  });

  it("only fixtures finished before the deadline count as finished; prices come from the previous gameweek", () => {
    const d = pointInTime(sd, K);
    expect(d.fixtures.filter((f) => f.finished).every((f) => f.event! < K)).toBe(true);
    expect(d.fixtures.some((f) => f.event === K && !f.finished)).toBe(true);
    const el = [...sd.rows.keys()][50];
    const prior = sd.rows.get(el)!.filter((r) => r.gw < K);
    const p = d.players.find((x) => x.id === el);
    if (p) expect(p.costTenths).toBe(prior[prior.length - 1].value);
    expect(d.events.find((e) => e.id === K)!.isNext).toBe(true);
    expect(d.events.filter((e) => e.finished).every((e) => e.id < K)).toBe(true);
  });

  it("the availability proxy uses past minutes only and is switched off by 'none'", () => {
    const withProxy = pointInTime(sd, K);
    const without = pointInTime(sd, K, { availability: "none" });
    expect(without.players.every((p) => p.status === "a" && p.chanceNext === null)).toBe(true);
    const flagged = withProxy.players.filter((p) => p.chanceNext === 0);
    expect(flagged.length).toBeGreaterThan(5);
    for (const p of flagged.slice(0, 20)) expect(p.news).toBe("");
  });

  it("data-quality gate: clean seasons pass, 2022-23 (no starts/xG early on) is excluded", () => {
    expect(historyQuality(sd, 6).ok).toBe(true);
    expect(historyQuality(sd, 34).ok).toBe(true);
    const old = loadSeason("2022-23");
    for (const k of [6, 12, 20, 34]) { const q = historyQuality(old, k); expect(q.ok, `k=${k}`).toBe(false); expect(q.reason).toMatch(/starts missing/); }
    expect(runSeason({ sd: old, strategies: MAIN_STRATEGIES, availability: "recent-minutes", firstK: 6, lastK: 20 }).windows).toHaveLength(0);
  }, 60000);

  it("harness invariants: legal squads, five gameweeks, unchanged optimiser, ≤2 per club for Balanced Plus, deterministic", () => {
    const run = () => runSeason({ sd, strategies: MAIN_STRATEGIES, availability: "recent-minutes", firstK: 6, lastK: 8 });
    const r = run();
    expect(r.windows).toHaveLength(3);
    expect(JSON.stringify(run().windows)).toBe(JSON.stringify(r.windows));
    for (const w of r.windows) {
      const dsk = pointInTime(sd, w.k);
      const by = new Map(dsk.players.map((p) => [p.id, p]));
      for (const s of MAIN_STRATEGIES) {
        const rec = w.strategies[s.id];
        expect(rec.gws.map((g) => g.gw)).toEqual([0, 1, 2, 3, 4].map((j) => w.k + j));
        expect(validateSquad(rec.squad, by, dsk.rules, 1000).errors, `${s.id} k=${w.k}`).toEqual([]);
        expect(rec.costTenths).toBeLessThanOrEqual(1000);
        for (const g of rec.gws) {
          expect(g.starting).toHaveLength(11);
          expect(g.bench).toHaveLength(4);
          expect(new Set([...g.starting, ...g.bench])).toEqual(new Set(rec.squad));
        }
      }
      // the three existing strategies are literally the unchanged optimiser run on the same point-in-time data
      for (const mode of ["balanced", "safe", "aggressive"] as const) {
        const direct = optimizeSquad(dsk, projectAll(dsk, w.k, { mode }).byId, { mode }).result.squad;
        expect(w.strategies[mode].squad).toEqual(direct);
      }
      for (const g of w.strategies["balanced-plus"].gws) if (g.relaxed === "none") expect(g.maxClubXI).toBeLessThanOrEqual(2);
    }
  });
});

describe("FPL scoring: auto-substitutions and vice-captain", () => {
  const pos: Record<number, Pos> = { 1: "GKP", 2: "DEF", 3: "DEF", 4: "DEF", 5: "MID", 6: "MID", 7: "MID", 8: "MID", 9: "FWD", 10: "FWD", 11: "FWD", 12: "GKP", 13: "DEF", 14: "MID", 15: "FWD" };
  const lineup = { starting: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 13, 14, 15], captain: 9, vice: 10 };
  const mk = (over: Record<number, [number, number]>) => (id: number) => { const o = over[id]; return o ? { points: o[0], minutes: o[1] } : { points: 2, minutes: 90 }; };
  it("counts XI points plus the captain's extra points", () => {
    const s = scoreGameweek(lineup, mk({ 9: [10, 90] }), (i) => pos[i]);
    expect(s.points).toBe(10 * 1 + 10 * 2 + 10);
    expect(s.captainPoints).toBe(10);
  });
  it("replaces a non-playing starter with the first bench player who played, keeping the formation legal", () => {
    const s = scoreGameweek(lineup, mk({ 2: [0, 0], 13: [6, 90], 14: [9, 90] }), (i) => pos[i]);
    expect(s.autoSubs).toEqual([{ out: 2, in: 13 }]);
    expect(s.benchUsedPoints).toBe(6);
    expect(s.benchUnusedPoints).toBe(2 + 9 + 2); // bench keeper, MID sub and FWD sub stay on the bench
  });
  it("a keeper is only replaced by the bench keeper", () => {
    const s = scoreGameweek(lineup, mk({ 1: [0, 0], 12: [7, 90] }), (i) => pos[i]);
    expect(s.autoSubs).toEqual([{ out: 1, in: 12 }]);
    const none = scoreGameweek(lineup, mk({ 1: [0, 0], 12: [0, 0] }), (i) => pos[i]);
    expect(none.autoSubs).toEqual([]);
  });
  it("does not make an illegal formation: a third defender cannot be dropped for a midfielder sub", () => {
    const l = { ...lineup, starting: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 14, 13, 15] };
    const s = scoreGameweek(l, mk({ 2: [0, 0], 14: [5, 90], 13: [4, 90] }), (i) => pos[i]);
    expect(s.autoSubs).toEqual([{ out: 2, in: 13 }]); // 14 (MID) would leave 2 DEF, illegal; 13 (DEF) is legal
  });
  it("the vice-captain captains if the captain does not play", () => {
    const s = scoreGameweek(lineup, mk({ 9: [0, 0], 10: [8, 90], 15: [3, 90] }), (i) => pos[i]);
    expect(s.captainDidNotPlay).toBe(true);
    expect(s.captainId).toBe(10);
    expect(s.captainPoints).toBe(8);
  });
});

describe("statistics helpers", () => {
  it("t interval, sign test, ranks", () => {
    const t = tInterval([1, 2, 3, 4, 5]);
    expect(t.mean).toBe(3);
    expect(t.hi - t.mean).toBeCloseTo(2.776 * Math.sqrt(2.5) / Math.sqrt(5), 2);
    expect(signTest([1, 1, 1, 1, 1, 1, 1, 1, 1, -1]).p).toBeCloseTo(0.0215, 3);
    expect(signTest([1, -1, 0, 0]).p).toBe(1);
    expect(ranks([5, 3, 5, 1])).toEqual([1.5, 3, 1.5, 4]);
  });
  it("block bootstrap is deterministic, brackets the mean and widens with noise", () => {
    const calm = [Array.from({ length: 30 }, (_, i) => 5 + (i % 3) * 0.1)];
    const noisy = [Array.from({ length: 30 }, (_, i) => 5 + ((i * 7) % 11) - 5)];
    const a = blockBootstrapCI(calm, 5, 1000, 1);
    expect(blockBootstrapCI(calm, 5, 1000, 1)).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(mean(calm[0]));
    expect(a.hi).toBeGreaterThanOrEqual(mean(calm[0]));
    const b = blockBootstrapCI(noisy, 5, 1000, 1);
    expect(b.hi - b.lo).toBeGreaterThan(a.hi - a.lo);
  });
});

describe("committed backtest results", () => {
  const file = path.join(process.cwd(), "docs", "backtest", "balanced-plus-backtest-results.json");
  const have = existsSync(file);
  const r = have ? JSON.parse(readFileSync(file, "utf8")) : null;
  it.skipIf(!have)("were produced by the frozen strategy code and the frozen data", () => {
    expect(r.frozen.sourceHashes).toEqual(currentConfig().sourceHashes);
    expect(r.frozen.balancedPlusParameters).toEqual(currentConfig().balancedPlusParameters);
    const frozenRec = JSON.parse(readFileSync(path.join(process.cwd(), "data", "backtest-frozen.json"), "utf8"));
    expect(frozenRec.config.sourceHashes).toEqual(r.frozen.sourceHashes);
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "data", "historical", "manifest.json"), "utf8"));
    expect(r.data.upstreamCommit).toBe(manifest.commit);
  });
  it.skipIf(!have)("cover four strategies, separate development from held-out evaluation, and record exclusions", () => {
    expect(r.design.strategies).toEqual(["balanced", "safe", "aggressive", "balanced-plus"]);
    expect(r.design.roles["2023-24"]).toBe("development");
    expect(r.design.roles["2024-25"]).toBe("evaluation");
    expect(r.design.roles["2025-26"]).toBe("evaluation");
    expect(r.evaluation.pooled.windows).toBe(58);
    expect(r.development.windows).toBe(29);
    expect(Object.keys(r.evaluation.perSeason)).toEqual(["2024-25", "2025-26"]);
    expect(r.supplementary["2022-23"].excluded).toMatch(/starts missing/);
    expect(r.assumptions.length).toBeGreaterThan(8);
    expect(r.sensitivity.variants.map((v: any) => v.id)).toEqual(expect.arrayContaining(["bp-flat-weights", "bp-front-loaded", "bp-no-security", "bp-no-club-cap"]));
  });
  it.skipIf(!have)("every strategy was scored on the same windows and the evidence label follows the stated rule", () => {
    for (const s of r.evaluation.pooled.strategies) expect(s.windows).toBe(58);
    const p = r.evaluation.pooled.pairedVsBaseline["balanced-plus"];
    const excl = (lo: number, hi: number) => lo > 0 || hi < 0;
    const both = excl(...(p.tCI95NonOverlapping as [number, number])) && excl(...(p.blockBootstrapCI95 as [number, number]));
    expect(p.evidence === "no-evidence-of-difference").toBe(!both);
    const v = loadValidationSummary();
    expect(v.available).toBe(true);
    expect(["advantage", "no-advantage-established", "underperforms", "insufficient-data"]).toContain(v.verdict);
  });
  it.skipIf(!have)("CSV exports are consistent with the JSON", () => {
    const rows = readFileSync(path.join(process.cwd(), "docs", "backtest", "windows.csv"), "utf8").trim().split("\n");
    const evalRows = rows.filter((l) => l.startsWith("2024-25,") || l.startsWith("2025-26,")).filter((l) => l.split(",")[4] === "balanced-plus");
    expect(evalRows).toHaveLength(58);
    const mean = evalRows.reduce((a, l) => a + Number(l.split(",")[5]), 0) / evalRows.length;
    expect(mean).toBeCloseTo(r.evaluation.pooled.strategies.find((s: any) => s.id === "balanced-plus").meanWindowPoints, 2);
  });
});
void createHash;

describe("release hygiene: data, limitations and objective-vs-displayed visibility", () => {
  it("historical snapshots match the manifest and are documented", () => {
    const v = verifyHistoricalManifest();
    expect(v.bad).toEqual([]);
    expect(v.checked).toBe(12);
    expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
    const readme = readFileSync(path.join(process.cwd(), "data", "historical", "README.md"), "utf8");
    for (const k of ["Pinned upstream commit", "backtest:verify-data", "--check", "Licence", "NOASSERTION", "2022-23", "no point-in-time injury"]) expect(readme.toLowerCase(), k).toContain(k.toLowerCase());
  });
  it("every limitation shown in the UI/PDF is also documented in the backtest report", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs", "BALANCED_PLUS_BACKTEST.md"), "utf8");
    expect(doc).toContain("## Limitations");
    for (const phrase of ["12 independent windows", "No point-in-time injury", "Single-hold strategy test", "Final fixture schedule", "stale", "2022-23", "multiple-comparison"]) expect(doc, phrase).toContain(phrase);
    expect(BACKTEST_LIMITATIONS.length).toBeGreaterThanOrEqual(5);
  });
  it("the strategy API, the PDF and the page expose objective vs displayed xPts and the limitations", async () => {
    const { GET } = await import("@/app/api/strategies/balanced-plus/route");
    const j = await (await GET(new Request("http://x/api?gw=11"))).json();
    expect(j.objective).toHaveLength(15);
    expect(j.strategy.methodology.objectiveVersusDisplayedXpts).toMatch(/DISPLAYED xPts/);
    expect(j.validation.limitations).toEqual(BACKTEST_LIMITATIONS);
    const page = readFileSync(path.join(process.cwd(), "app", "strategies", "balanced-plus", "page.tsx"), "utf8");
    expect(page).toContain("Optimiser objective vs displayed xPts");
    expect(page).toContain("not</b> the Balanced Plus objective");
    expect(page).toContain("Limitations");
    const { GET: pdf } = await import("@/app/api/strategies/balanced-plus/report/route");
    const text = (await pdfInfo(Buffer.from(await (await pdf(new Request("http://x/api?gw=11"))).arrayBuffer()))).text.replace(/\s+/g, " ");
    expect(text).toContain("Limitations of this validation");
    for (const l of BACKTEST_LIMITATIONS) expect(text).toContain(l.slice(0, 40));
    expect(text).toContain("DISPLAYED xPts");
  });
});
