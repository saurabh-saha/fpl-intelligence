import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectAll } from "@/lib/analytics/playerScoring";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";
import { validateLineup, validateSquad } from "@/lib/optimizer/validation";
import { buildHorizon } from "@/lib/season/horizon";
import { BALANCED_PLUS, balancedPlusValues, optimizeBalancedPlus, pickCaptaincyIndependently } from "@/lib/strategies/balancedPlus";
import { balancedPlusSquad, compareAll, existingStrategies } from "@/lib/strategies/compare";
import type { Dataset } from "@/lib/fpl/types";
import { compact, embeddedJson, pdfInfo, textJson } from "./pdfHelpers";
import { NEXT_GW } from "./helpers";
import { by, ds } from "./seasonHelpers";

vi.mock("@/lib/fpl/client", () => ({
  getDataset: async () => (await import("./helpers")).sampleDataset(),
  getElementSummary: async () => null,
}));

const hz = buildHorizon(ds, NEXT_GW);
const bp = optimizeBalancedPlus(ds, hz);
const clubCounts = (ids: number[]) => ids.reduce<Map<number, number>>((m, id) => m.set(by.get(id)!.teamId, (m.get(by.get(id)!.teamId) ?? 0) + 1), new Map());

describe("existing strategies are untouched (regression snapshot of the unchanged optimiser)", () => {
  const expected = {
    balanced: { starting: [385, 112, 60, 4, 566, 68, 183, 542, 411, 379, 166], bench: [496, 45, 124, 504], captain: 411, vice: 379, formation: "4-3-3", cost: 998 },
    safe: { starting: [385, 112, 60, 4, 566, 68, 542, 15, 411, 379, 249], bench: [572, 124, 504, 183], captain: 411, vice: 379, formation: "4-3-3", cost: 1000 },
    aggressive: { starting: [385, 112, 60, 566, 183, 542, 68, 366, 411, 379, 249], bench: [350, 45, 504, 87], captain: 411, vice: 379, formation: "3-4-3", cost: 968 },
  } as const;
  for (const mode of ["balanced", "safe", "aggressive"] as const) {
    it(`${mode} still produces the exact same squad, XI, bench, captains and cost`, () => {
      const { byId } = projectAll(ds, NEXT_GW, { mode });
      const r = optimizeSquad(ds, byId, { mode }).result;
      expect({ starting: r.starting, bench: r.bench, captain: r.captain, vice: r.viceCaptain, formation: r.formation, cost: r.totalCostTenths }).toEqual(expected[mode]);
    });
  }
});

describe("Balanced Plus: hard rules", () => {
  it("uses the same £100m budget and returns a legal 15-player squad", () => {
    expect(bp.squad).toHaveLength(15);
    expect(bp.totalCostTenths).toBeLessThanOrEqual(ds.rules.budgetTenths);
    expect(bp.totalCostTenths + bp.remainingTenths).toBe(1000);
    expect(validateSquad(bp.squad, by, ds.rules, 1000).valid).toBe(true);
    expect(validateLineup({ starting: bp.starting, bench: bp.bench, formation: bp.formation, captain: bp.captain, viceCaptain: bp.viceCaptain }, bp.squad, by, ds.rules).valid).toBe(true);
    for (const c of clubCounts(bp.squad).values()) expect(c).toBeLessThanOrEqual(3);
  });

  it("never has more than 2 players from one club in the starting XI", () => {
    expect(Math.max(...clubCounts(bp.starting).values())).toBeLessThanOrEqual(2);
  });

  it("the existing strategies DO break that rule on this snapshot (so the cap is binding)", () => {
    const others = existingStrategies(ds, NEXT_GW);
    expect(others.some((s) => Math.max(...clubCounts(s.starting).values()) >= 3)).toBe(true);
  });

  it("every starter is a secure starter with real minutes", () => {
    const p0 = hz.proj[0];
    for (const id of bp.starting) {
      const pr = p0.get(id)!;
      expect(pr.startProb, by.get(id)!.webName).toBeGreaterThanOrEqual(BALANCED_PLUS.xiMinStartProb);
      expect(pr.expMinutes).toBeGreaterThanOrEqual(BALANCED_PLUS.xiMinExpMinutes);
      expect(pr.availability).toBeGreaterThanOrEqual(BALANCED_PLUS.xiMinAvailability);
    }
  });

  it("keeps a strong, playable bench: outfield subs are real options and the xPts target is met", () => {
    const p0 = hz.proj[0];
    const outfield = bp.bench.filter((id) => by.get(id)!.pos !== "GKP");
    expect(outfield).toHaveLength(3);
    for (const id of outfield) expect(p0.get(id)!.startProb).toBeGreaterThanOrEqual(BALANCED_PLUS.benchMinStartProb);
    expect(by.get(bp.bench[0])!.pos).toBe("GKP");
    expect(p0.get(bp.bench[0])!.availability).toBeGreaterThanOrEqual(0.9);
    expect(bp.benchTargetMet).toBeGreaterThanOrEqual(10);
    expect(bp.benchEp).toBeGreaterThanOrEqual(bp.benchTargetMet - 1e-6);
    // and at least as strong as Balanced's bench
    const balanced = existingStrategies(ds, NEXT_GW).find((s) => s.key === "balanced")!;
    const balancedBench = balanced.bench.reduce((a, id) => a + p0.get(id)!.ep, 0);
    expect(bp.benchEp).toBeGreaterThanOrEqual(balancedBench - 0.5);
  });

  it("never picks unavailable or doubtful players", () => {
    for (const id of bp.squad) {
      expect(["u", "s", "n"]).not.toContain(by.get(id)!.status);
      expect(hz.proj[0].get(id)!.availability).toBeGreaterThanOrEqual(BALANCED_PLUS.minAvailability);
    }
  });

  it("is deterministic", () => {
    const again = optimizeBalancedPlus(ds, buildHorizon(ds, NEXT_GW));
    expect(again.squad).toEqual(bp.squad);
    expect(again.captain).toBe(bp.captain);
  });
});

describe("Balanced Plus: value function", () => {
  const vals = balancedPlusValues(ds, hz);
  const haaland = ds.players.find((p) => p.webName === "Haaland")!;
  const clone = (mut: (d: Dataset) => void): Dataset => {
    const d = { ...ds, players: ds.players.map((p) => ({ ...p })) };
    mut(d);
    return d;
  };

  it("evaluates five gameweeks, not just GW11", () => {
    expect(hz.gws).toHaveLength(5);
    const v = vals.get(haaland.id)!;
    const manual = hz.proj.reduce((s, pm, k) => s + pm.get(haaland.id)!.ep * hz.weights[k], 0) / hz.weights.reduce((a, b) => a + b, 0);
    expect(v.rawEp5).toBeCloseTo(manual, 1);
    expect(Math.abs(v.value - v.ep0)).toBeGreaterThan(0.01); // differs from the one-gameweek number
    const ranks = (f: (x: ReturnType<typeof vals.get>) => number) => [...vals.values()].sort((a, b) => f(b) - f(a)).slice(0, 40).map((x) => x.id).join();
    expect(ranks((x) => x!.value)).not.toBe(ranks((x) => x!.ep0));
  });

  it("a player with a great GW11 but bad next four is worth less than a steady one", () => {
    const steady = ds.players.find((p) => p.webName === "Isak")!;
    const hzFlip = buildHorizon(ds, NEXT_GW);
    // fabricate: boost steady's later gameweeks' xPts, cut Haaland's later ones (keeps GW11 equal)
    const bump = (id: number, f: number) => hzFlip.proj.forEach((m, k) => k > 0 && m.set(id, { ...m.get(id)!, ep: m.get(id)!.ep * f, components: { ...m.get(id)!.components, goals: m.get(id)!.components.goals * f, assists: m.get(id)!.components.assists * f, formAdj: m.get(id)!.components.formAdj * f } }));
    const before = balancedPlusValues(ds, hzFlip);
    bump(haaland.id, 0.4);
    bump(steady.id, 1.6);
    const after = balancedPlusValues(ds, hzFlip);
    expect(after.get(haaland.id)!.value).toBeLessThan(before.get(haaland.id)!.value);
    expect(after.get(steady.id)!.value).toBeGreaterThan(before.get(steady.id)!.value);
    expect(after.get(haaland.id)!.ep0).toBe(before.get(haaland.id)!.ep0);
  });

  it("recent form does not change the value (form tilt removed) even though it changes the raw projection", () => {
    const p = ds.players.find((x) => x.webName === "Tavernier")!;
    const hot = clone((d) => (d.players.find((x) => x.id === p.id)!.form = 12));
    const cold = clone((d) => (d.players.find((x) => x.id === p.id)!.form = 1));
    const vh = balancedPlusValues(hot, buildHorizon(hot, NEXT_GW)).get(p.id)!;
    const vc = balancedPlusValues(cold, buildHorizon(cold, NEXT_GW)).get(p.id)!;
    expect(vh.rawEp5).toBeGreaterThan(vc.rawEp5 + 0.05);
    expect(vh.value).toBeCloseTo(vc.value, 1);
    expect(vh.formRemoved5).toBeGreaterThan(vc.formRemoved5);
  });

  it("is built on xG and xA: extra realised goals or assists (same xG/xA) do not move it", () => {
    const base = vals.get(haaland.id)!.value;
    const luckier = clone((d) => { const x = d.players.find((q) => q.id === haaland.id)!; x.goals += 2; x.assists += 2; });
    const v = balancedPlusValues(luckier, buildHorizon(luckier, NEXT_GW)).get(haaland.id)!.value;
    expect(v).toBeCloseTo(base, 1);
    const moreXg = clone((d) => { const x = d.players.find((q) => q.id === haaland.id)!; x.xG *= 1.15; x.xGI = x.xG + x.xA; });
    expect(balancedPlusValues(moreXg, buildHorizon(moreXg, NEXT_GW)).get(haaland.id)!.value).toBeGreaterThan(base);
    const moreXa = clone((d) => { const x = d.players.find((q) => q.id === haaland.id)!; x.xA += 1.2; x.xGI = x.xG + x.xA; });
    expect(balancedPlusValues(moreXa, buildHorizon(moreXa, NEXT_GW)).get(haaland.id)!.value).toBeGreaterThan(base);
  });

  it("minutes security: a rotation risk is penalised against a regular starter with the same output", () => {
    const starter = ds.players.find((p) => p.pos === "MID" && p.starts >= 9 && p.minutes > 800 && p.status === "a")!;
    const risk = clone((d) => { const x = d.players.find((q) => q.id === starter.id)!; x.starts = 3; x.minutes = 300; });
    const v1 = balancedPlusValues(ds, hz).get(starter.id)!;
    const v2 = balancedPlusValues(risk, buildHorizon(risk, NEXT_GW)).get(starter.id)!;
    expect(v2.value).toBeLessThan(v1.value);
    expect(v2.xiEligible).toBe(false);
  });

  it("the squad leans on underlying attack rather than assists: assist share of xGI is modest and xGI/90 is at least Balanced's", () => {
    const cmp = compareAll(ds, hz, bp, existingStrategies(ds, NEXT_GW));
    const m = Object.fromEntries(cmp.metrics.map((x) => [x.key, x]));
    expect(m["balanced-plus"].xiAssistShareOfXgi).toBeLessThan(0.4);
    expect(m["balanced-plus"].xiXgi90Outfield).toBeGreaterThanOrEqual(m.balanced.xiXgi90Outfield);
    expect(m["balanced-plus"].xiFormTiltXpts).toBeLessThan(m.balanced.xiFormTiltXpts);
  });
});

describe("Balanced Plus: captaincy is optimised independently", () => {
  it("captain = highest raw model xPts in the XI, whatever the squad objective values", () => {
    const top = [...bp.starting].sort((a, b) => hz.proj[0].get(b)!.ep - hz.proj[0].get(a)!.ep)[0];
    expect(bp.captain).toBe(top);
    // the squad-value ranking is not what decides the armband
    const byValue = [...bp.starting].sort((a, b) => bp.values.get(b)!.value - bp.values.get(a)!.value)[0];
    expect(bp.captaincy.ranking[0].id).toBe(top);
    void byValue;
  });
  it("vice is a secure starter from a different club to the captain", () => {
    expect(by.get(bp.viceCaptain)!.teamId).not.toBe(by.get(bp.captain)!.teamId);
    expect(hz.proj[0].get(bp.viceCaptain)!.startProb).toBeGreaterThanOrEqual(BALANCED_PLUS.viceMinStartProb);
    expect(bp.captain).not.toBe(bp.viceCaptain);
  });
  it("picks the next-best from another club even when the 2nd-best player shares the captain's club", () => {
    const xi = bp.starting;
    const sorted = [...xi].sort((a, b) => hz.proj[0].get(b)!.ep - hz.proj[0].get(a)!.ep);
    const capClub = by.get(sorted[0])!.teamId;
    const mate = ds.players.find((p) => p.teamId === capClub && p.pos === "MID" && !xi.includes(p.id))!;
    // swap the second-best for a captain's club-mate with a higher projection
    const hz2 = buildHorizon(ds, NEXT_GW);
    hz2.proj[0].set(mate.id, { ...hz2.proj[0].get(mate.id)!, ep: hz2.proj[0].get(sorted[0])!.ep - 0.01, startProb: 1, availability: 1 });
    const xi2 = [sorted[0], mate.id, ...sorted.slice(2)];
    const c = pickCaptaincyIndependently(xi2, hz2, by);
    expect(c.captain).toBe(sorted[0]);
    expect(c.vice).not.toBe(mate.id);
    expect(by.get(c.vice)!.teamId).not.toBe(capClub);
  });
});

describe("Comparison against all three previous strategies", () => {
  const baselines = existingStrategies(ds, NEXT_GW);
  const cmp = compareAll(ds, hz, bp, baselines);

  it("covers Balanced, Safe, Aggressive and Balanced Plus from the same snapshot and budget", () => {
    expect(cmp.metrics.map((m) => m.key)).toEqual(["balanced", "safe", "aggressive", "balanced-plus"]);
    expect(cmp.changes.map((c) => c.against)).toEqual(["balanced", "safe", "aggressive"]);
    for (const m of cmp.metrics) { expect(m.costM).toBeLessThanOrEqual(100); expect(m.perGw).toHaveLength(5); }
    const plus = cmp.metrics[3];
    expect(plus.maxClubInXI).toBe(2);
    expect(plus.gw0Xpts).toBeCloseTo(bp.expectedPoints, 1);
  });

  for (const [i, key] of (["balanced", "safe", "aggressive"] as const).entries()) {
    it(`explains EVERY changed player vs ${key}`, () => {
      const ch = cmp.changes[i];
      const base = baselines[i];
      const baseAll = new Set([...base.starting, ...base.bench]);
      const added = bp.squad.filter((id) => !baseAll.has(id));
      const removed = [...baseAll].filter((id) => !bp.squad.includes(id));
      expect(ch.swaps).toHaveLength(added.length);
      expect(ch.swaps).toHaveLength(removed.length);
      expect(ch.swaps.map((s) => s.in.id).sort()).toEqual([...added].sort());
      expect(ch.swaps.map((s) => s.out.id).sort()).toEqual([...removed].sort());
      for (const s of ch.swaps) {
        expect(by.get(s.out.id)!.pos).toBe(by.get(s.in.id)!.pos);
        expect(s.whyOut.length).toBeGreaterThan(0);
        expect(s.whyIn.length).toBeGreaterThan(0);
        expect(s.explanation).toContain(s.out.name);
        expect(s.explanation).toContain(s.in.name);
        expect(s.explanation.length).toBeGreaterThan(80);
      }
      const common = bp.squad.filter((id) => baseAll.has(id));
      const roleDiff = common.filter((id) => base.starting.includes(id) !== bp.starting.includes(id));
      expect(ch.roleChanges.map((r) => r.player.id).sort()).toEqual([...roleDiff].sort());
      ch.roleChanges.forEach((r) => expect(r.explanation.length).toBeGreaterThan(40));
      expect(ch.captaincy.explanation).toContain("Captain");
      expect(ch.overlap).toBe(common.length);
    });

    it(`explanations vs ${key} only state facts that hold in the data`, () => {
      const ch = cmp.changes[i];
      const base = baselines[i];
      const baseXiClubs = clubCounts(base.starting);
      for (const s of ch.swaps) {
        for (const w of s.whyOut) {
          if (w.includes("allows at most 2 per club")) expect(baseXiClubs.get(by.get(s.out.id)!.teamId)!).toBeGreaterThan(2);
          if (w.includes("recent-form tilt")) expect(bp.values.get(s.out.id)!.formRemoved5).toBeGreaterThanOrEqual(0.15);
          if (w.startsWith("Realised returns")) expect(bp.values.get(s.out.id)!.attackShift5).toBeLessThanOrEqual(-0.15);
          if (w.startsWith("Lower five-gameweek value")) expect(bp.values.get(s.out.id)!.value).toBeLessThan(bp.values.get(s.in.id)!.value);
          if (w.startsWith("Not secure enough")) expect(bp.values.get(s.out.id)!.xiEligible).toBe(false);
        }
        expect(s.in.fiveGwValue).toBe(bp.values.get(s.in.id)!.value);
      }
    });
  }

  it("the club cap is what separates Balanced Plus from Balanced on the BOU players", () => {
    const ch = cmp.changes[0];
    const text = ch.swaps.flatMap((s) => s.whyOut).concat(ch.roleChanges.map((r) => r.explanation)).join(" ");
    expect(text).toMatch(/BOU players/);
  });
});

describe("Balanced Plus: API and PDF report in the existing format", () => {
  let json: any;
  let pdfRes: Response;
  let pdfBuf: Buffer;
  beforeAll(async () => {
    const { GET } = await import("@/app/api/strategies/balanced-plus/route");
    json = await (await GET(new Request("http://x/api?gw=11"))).json();
    const { GET: report } = await import("@/app/api/strategies/balanced-plus/report/route");
    pdfRes = await report(new Request("http://x/api?gw=11"));
    pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  });

  it("JSON endpoint returns the squad and the full comparison", () => {
    expect(json.squad.starting).toHaveLength(11);
    expect(json.squad.bench).toHaveLength(4);
    expect(json.comparison.metrics).toHaveLength(4);
    expect(json.comparison.changes).toHaveLength(3);
    expect(json.strategy.rules.length).toBeGreaterThan(5);
    expect(json.squad.squadIds).toEqual(bp.squad);
  });

  it("PDF is a real, text-extractable report with the standard sections plus the comparison appendix", async () => {
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(pdfRes.headers.get("content-disposition")).toContain("fpl-gw11-balanced-plus-report.pdf");
    expect(pdfRes.headers.get("x-report-squad")).toBe(bp.squad.join(","));
    const info = await pdfInfo(pdfBuf);
    expect(info.title).toBe("Gameweek 11 Intelligence Report: Balanced Plus");
    expect(info.attachmentNames).toContain("fpl-gw11-report.json");
    for (const h of ["Squad summary", "Starting XI (3-4-3)", "Bench (in substitution order)", "Expected-points breakdown", "Fixtures and expected points: next five gameweeks", "Why each player is in the squad", "Replacement shortlist", "Model, confidence and known limitations", "Structured data (machine-readable)"]) expect(info.text, h).toContain(h);
    for (const h of ["Balanced Plus: strategy definition", "Strategy comparison: Balanced Plus vs Balanced, Safe and Aggressive", "Balanced Plus vs Balanced:", "Balanced Plus vs Safe:", "Balanced Plus vs Aggressive:"]) expect(info.text, h).toContain(h);
    for (const id of bp.squad) expect(info.text).toContain(by.get(id)!.webName);
    expect(info.text).toContain(`${by.get(bp.captain)!.webName} (C)`);
    expect(info.text).toContain(`${by.get(bp.viceCaptain)!.webName} (V)`);
  });

  it("every changed player is explained in the PDF text and in the structured JSON; printed JSON equals attached JSON", async () => {
    const info = await pdfInfo(pdfBuf);
    const flat = info.text.replace(/\s+/g, " ");
    const att = embeddedJson(pdfBuf);
    expect(att.strategyComparison.changes).toHaveLength(3);
    for (const ch of att.strategyComparison.changes) {
      expect(ch.swaps.length + ch.roleChanges.length).toBe(ch.totalChanges);
      for (const s of ch.swaps) {
        expect(flat).toContain(`${s.out.name} -> ${s.in.name}`);
        expect(s.whyOut.length).toBeGreaterThan(0);
        expect(s.whyIn.length).toBeGreaterThan(0);
      }
      for (const r of ch.roleChanges) expect(r.explanation).toContain(r.player.name);
    }
    expect(att.strategy.name).toBe("Balanced Plus");
    expect(att.players).toHaveLength(15);
    expect(att.squad.startingXI).toEqual(bp.starting);
    expect(att.squad.captainId).toBe(bp.captain);
    expect(att.optimisationMode).toBe("balanced-plus");
    expect(att.strategyComparison.metrics.map((m: any) => m.key)).toEqual(["balanced", "safe", "aggressive", "balanced-plus"]);
    expect(textJson(info.text)).toBe(compact(att));
  });
});
