import { describe, expect, it } from "vitest";
import { analyseTransfers, bankValue, MIN_EDGE } from "@/lib/season/transfers";
import { benchBoostGain, chipExpectedPoints, chipStrategy, tripleCaptainGain } from "@/lib/season/chips";
import { buildHorizon, squadValue } from "@/lib/season/horizon";
import { seasonAlternatives } from "@/lib/season/alternatives";
import { applyPlan } from "@/lib/season/squad";
import { bestLineup } from "@/lib/optimizer/formationOptimizer";
import { ds, by, mediocreSquad, optimalSquad } from "./seasonHelpers";
import { NEXT_GW } from "./helpers";

const hz = buildHorizon(ds, NEXT_GW);

describe("transfer optimiser", () => {
  const weak = mediocreSquad({ freeTransfers: 1 });

  it("every recommended transfer plan is legal under the deterministic rules engine", () => {
    const a = analyseTransfers(ds, weak, NEXT_GW, hz);
    expect(a.options.length).toBeGreaterThan(2);
    for (const o of a.options) {
      const r = applyPlan(weak, { transfers: o.transfers.map((t) => ({ out: t.out, in: t.in })) }, ds, NEXT_GW);
      expect(r.errors, `option ${o.n}`).toEqual([]);
      expect(r.hitCost).toBe(o.hitCost);
      expect(r.bankTenths).toBe(o.bankAfterTenths);
      expect(r.bankTenths).toBeGreaterThanOrEqual(0);
    }
  });

  it("net = horizon gain minus hit cost, and deductions follow the free-transfer count", () => {
    const a = analyseTransfers(ds, { ...weak, freeTransfers: 2 }, NEXT_GW, hz);
    for (const o of a.options) {
      expect(o.net).toBeCloseTo(o.gainHorizon - o.hitCost, 1);
      const deductions = o.transfers.reduce((s, t) => s + t.deduction, 0);
      expect(deductions).toBe(Math.max(0, o.n - 2) * 4);
      o.transfers.forEach((t) => expect(t.net).toBeCloseTo(t.gainHorizon - t.deduction, 1));
    }
  });

  it("recommends using a transfer on a weak squad and explains why", () => {
    const a = analyseTransfers(ds, weak, NEXT_GW, hz);
    expect(["transfer", "hit"]).toContain(a.action);
    const best = a.options[a.recommendedN];
    expect(best.net).toBeGreaterThan(0);
    best.transfers.forEach((t) => expect(t.explanation.length).toBeGreaterThan(30));
  });

  it("does NOT force a transfer: an already-optimal squad is told to save", () => {
    const a = analyseTransfers(ds, optimalSquad({ freeTransfers: 1 }), NEXT_GW, hz);
    expect(a.action).toBe("save");
    expect(a.recommendedN).toBe(0);
    expect(a.headline.toLowerCase()).toContain("save");
  });

  it("never recommends a -4 hit unless it beats saving by a clear margin", () => {
    for (const ft of [1, 2, 3]) {
      const a = analyseTransfers(ds, { ...weak, freeTransfers: ft }, NEXT_GW, hz);
      const chosen = a.options[a.recommendedN];
      if (chosen.hitCost > 0) expect(chosen.score).toBeGreaterThan(a.options[0].score + MIN_EDGE + 1);
    }
  });

  it("with more banked transfers it makes more free moves before paying hits", () => {
    const one = analyseTransfers(ds, { ...weak, freeTransfers: 1 }, NEXT_GW, hz);
    const five = analyseTransfers(ds, { ...weak, freeTransfers: 5 }, NEXT_GW, hz);
    expect(five.options.find((o) => o.n === 3)!.hitCost).toBe(0);
    expect(one.options.find((o) => o.n === 3)!.hitCost).toBe(8);
    expect(five.recommendedN).toBeGreaterThanOrEqual(one.recommendedN);
  });

  it("banking value is capped: at 5 free transfers saving earns no extra credit", () => {
    expect(bankValue(1)).toBe(0);
    expect(bankValue(2)).toBeGreaterThan(0);
    expect(bankValue(5) - bankValue(4)).toBeLessThan(bankValue(3) - bankValue(2));
  });

  it("respects the bank: with no money only like-for-like or cheaper swaps appear", () => {
    const broke = { ...weak, bankTenths: 0 };
    const a = analyseTransfers(ds, broke, NEXT_GW, hz);
    for (const o of a.options) expect(o.bankAfterTenths).toBeGreaterThanOrEqual(0);
    for (const s of a.sellCandidates) for (const alt of s.alternatives) expect(alt.priceDiffTenths).toBeLessThanOrEqual(0);
  });

  it("uses the selling price when judging affordability", () => {
    // Make every holding 'bought' much cheaper => lower selling price => fewer affordable upgrades
    const lowBuy = { ...weak, bankTenths: 0, holdings: weak.holdings.map((h) => ({ ...h, buyTenths: Math.max(40, by.get(h.id)!.costTenths - 20) })) };
    const a = analyseTransfers(ds, lowBuy, NEXT_GW, hz);
    for (const s of a.sellCandidates) {
      const own = lowBuy.holdings.find((h) => h.id === s.out)!;
      expect(s.sellTenths).toBeLessThanOrEqual(by.get(s.out)!.costTenths);
      if (by.get(s.out)!.costTenths > own.buyTenths) expect(s.sellTenths).toBeLessThan(by.get(s.out)!.costTenths);
    }
  });

  it("offers up to five alternatives for every player in the squad", () => {
    const a = analyseTransfers(ds, weak, NEXT_GW, hz);
    expect(a.sellCandidates).toHaveLength(15);
    for (const s of a.sellCandidates) {
      expect(s.alternatives.length).toBeLessThanOrEqual(5);
      for (const alt of s.alternatives) {
        const r = applyPlan(weak, { transfers: [{ out: alt.out, in: alt.in }] }, ds, NEXT_GW);
        expect(r.errors, `${alt.out}->${alt.in}`).toEqual([]);
      }
    }
    expect(a.sellCandidates.filter((s) => s.alternatives.length === 5).length).toBeGreaterThan(10);
  });

  it("a flagged (injured/unavailable) squad member is surfaced for sale", () => {
    const hurt = ds.players.find((p) => p.status === "i" && p.pos === "MID" && p.minutes > 300) ?? ds.players.find((p) => p.status === "i" && p.minutes > 300)!;
    const squad = mediocreSquad();
    const swapIn = squad.holdings.find((h) => by.get(h.id)!.pos === hurt.pos && !squad.holdings.some((x) => x.id === hurt.id))!;
    const withHurt = { ...squad, holdings: squad.holdings.map((h) => (h.id === swapIn.id ? { id: hurt.id, buyTenths: hurt.costTenths } : h)) };
    // ignore club-limit artefacts of the synthetic swap
    const counts = new Map<number, number>();
    withHurt.holdings.forEach((h) => counts.set(by.get(h.id)!.teamId, (counts.get(by.get(h.id)!.teamId) ?? 0) + 1));
    if ([...counts.values()].some((n) => n > 3)) return;
    const a = analyseTransfers(ds, withHurt, NEXT_GW, hz);
    const entry = a.sellCandidates.find((s) => s.out === hurt.id)!;
    expect(entry.alternatives.length).toBeGreaterThan(0);
    expect(entry.alternatives[0].gainHorizon).toBeGreaterThan(0);
    expect(entry.reason).toMatch(/Availability|starter|Projects/);
  });

  it("runs fast enough to be interactive", () => {
    const t0 = Date.now();
    analyseTransfers(ds, weak, NEXT_GW, hz);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("chips: expected points and strategy", () => {
  const squad = mediocreSquad();
  const players = squad.holdings.map((h) => by.get(h.id)!);
  const proj = hz.proj[0];

  it("Bench Boost counts all 15 players", () => {
    const lineup = bestLineup(players, proj, ds.rules);
    const bench = lineup.bench.reduce((s, id) => s + proj.get(id)!.ep, 0);
    expect(benchBoostGain(players, proj, ds)).toBeCloseTo(bench, 1);
    expect(chipExpectedPoints(players, proj, ds, "bboost")).toBeCloseTo(chipExpectedPoints(players, proj, ds, null) + bench, 1);
  });

  it("Triple Captain triples the captain's points (one extra captain's worth over the normal double)", () => {
    const lineup = bestLineup(players, proj, ds.rules);
    const c = proj.get(lineup.captain)!.ep;
    expect(tripleCaptainGain(players, proj, ds)).toBeCloseTo(c, 1);
    expect(chipExpectedPoints(players, proj, ds, "3xc")).toBeCloseTo(chipExpectedPoints(players, proj, ds, null) + c, 1);
  });

  it("strategy covers every available chip with a verdict and reasoning", () => {
    const advice = chipStrategy(ds, squad, NEXT_GW, 3, hz);
    expect(advice.map((a) => a.chip).sort()).toEqual(["3xc", "bboost", "freehit", "wildcard"]);
    for (const a of advice) {
      expect(["use-now", "save", "use-soon"]).toContain(a.verdict);
      expect(a.text.length).toBeGreaterThan(20);
      expect(a.options.length).toBeGreaterThan(0);
    }
  });

  it("used chips are reported unavailable and not recommended", () => {
    const advice = chipStrategy(ds, { ...squad, chipsUsed: [{ name: "wildcard", event: 4 }, { name: "bboost", event: 7 }] }, NEXT_GW, 3, hz);
    expect(advice.find((a) => a.chip === "wildcard")!.verdict).toBe("unavailable");
    expect(advice.find((a) => a.chip === "bboost")!.verdict).toBe("unavailable");
    expect(advice.find((a) => a.chip === "3xc")!.available).toBe(true);
  });

  it("a chip about to expire is steered to its best remaining gameweek (use it or lose it)", () => {
    const late = { ...squad, gw: 18 };
    const hz18 = buildHorizon(ds, 18);
    const adv = chipStrategy(ds, late, 18, 3, hz18).find((a) => a.chip === "bboost")!;
    expect(["use-now", "use-soon"]).toContain(adv.verdict);
    expect(adv.text).toMatch(/expires after GW19/);
  });

  it("Free Hit is never offered for GW1", () => {
    const hz1 = buildHorizon(ds, 2);
    const adv = chipStrategy(ds, { ...squad, gw: 2 }, 2, 0, hz1).find((a) => a.chip === "freehit")!;
    expect(adv.options.every((o) => o.gw !== 1)).toBe(true);
  });
});

describe("replacement candidates in the proposed squad", () => {
  const squad = mediocreSquad({ freeTransfers: 1 });

  it("lists only legal swaps and flags an extra -4 when it exceeds free transfers", () => {
    const o = squad.holdings.find((h) => by.get(h.id)!.pos === "MID")!.id;
    const o2 = squad.holdings.filter((h) => by.get(h.id)!.pos === "MID")[1].id;
    const first = seasonAlternatives(ds, squad, undefined, NEXT_GW, o, hz);
    expect(first.length).toBeGreaterThan(10);
    for (const a of first.slice(0, 15)) {
      const r = applyPlan(squad, { transfers: [{ out: o, in: a.playerId }] }, ds, NEXT_GW);
      expect(r.valid).toBe(true);
      expect(a.extraHit).toBe(0);
      expect(a.bankAfterTenths).toBe(r.bankTenths);
    }
    const second = seasonAlternatives(ds, squad, { transfers: [{ out: o, in: first[0].playerId }] }, NEXT_GW, o2, hz);
    expect(second.every((a) => a.extraHit === 4)).toBe(true);
    expect(second.every((a) => a.net === Math.round((a.deltaHorizon - 4) * 100) / 100)).toBe(true);
  });

  it("replacing a player bought earlier in the plan does not add a second transfer", () => {
    const o = squad.holdings.find((h) => by.get(h.id)!.pos === "FWD")!.id;
    const alts = seasonAlternatives(ds, squad, undefined, NEXT_GW, o, hz);
    const bought = alts[0].playerId;
    const again = seasonAlternatives(ds, squad, { transfers: [{ out: o, in: bought }] }, NEXT_GW, bought, hz);
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((a) => a.extraHit === 0)).toBe(true);
  });

  it("Free Hit alternatives are bounded by selling value + bank, not by selling prices of single players", async () => {
    const { planFreeHit } = await import("@/lib/season/chips");
    const fh = planFreeHit(ds, squad, NEXT_GW, hz);
    const plan = { transfers: [], chip: "freehit" as const, freeHitIds: fh.ids };
    const alts = seasonAlternatives(ds, squad, plan, NEXT_GW, fh.ids[3], hz);
    const total = fh.budgetTenths;
    const base = fh.ids.reduce((s, id) => s + by.get(id)!.costTenths, 0);
    for (const a of alts) expect(a.bankAfterTenths).toBeGreaterThanOrEqual(0);
    expect(total - base).toBeGreaterThanOrEqual(0);
  });

  it("squad value helper is monotonic: a better XI is worth more", () => {
    const a = squadValue(squad.holdings.map((h) => by.get(h.id)!), hz, ds).weighted;
    const b = squadValue(optimalSquad().holdings.map((h) => by.get(h.id)!), hz, ds).weighted;
    expect(b).toBeGreaterThan(a);
  });
});
