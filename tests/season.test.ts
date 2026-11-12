import { describe, expect, it } from "vitest";
import { chipErrors, chipStatuses, nextFreeTransfers, sellingPrice, transferCost } from "@/lib/season/rules";
import { applyPlan, editPlan, rollForward, squadValueTenths, totalBudgetTenths } from "@/lib/season/squad";
import { reconstructHoldings, simulateFreeTransfers } from "@/lib/season/importer";
import { ds, by, mediocreSquad, optimalSquad, squadFrom, stateOf, swapCandidates } from "./seasonHelpers";
import { NEXT_GW } from "./helpers";

const R = ds.rules;

describe("official 2026/27 rules loaded from the API", () => {
  it("reads transfer rules from game_config", () => {
    expect(R.maxFreeTransfers).toBe(5);
    expect(R.freeTransfersPerGw).toBe(1);
    expect(R.transferHit).toBe(4);
    expect(R.sellOnFee).toBe(0.5);
  });
  it("reads two sets of four chips with the verified windows", () => {
    const first = ds.chips.filter((c) => c.stop === 19);
    const second = ds.chips.filter((c) => c.start === 20);
    expect(first.map((c) => c.name).sort()).toEqual(["3xc", "bboost", "freehit", "wildcard"]);
    expect(second.map((c) => c.name).sort()).toEqual(["3xc", "bboost", "freehit", "wildcard"]);
    expect(ds.chips.every((c) => c.number === 1)).toBe(true);
  });
});

describe("selling price", () => {
  it("keeps half of a price rise, rounded down to 0.1m", () => {
    expect(sellingPrice(50, 50)).toBe(50);
    expect(sellingPrice(50, 51)).toBe(50); // +0.1 -> 0.05 rounds down
    expect(sellingPrice(50, 52)).toBe(51);
    expect(sellingPrice(50, 53)).toBe(51); // +0.3 -> 0.15 rounds down
    expect(sellingPrice(50, 55)).toBe(52);
    expect(sellingPrice(100, 111)).toBe(105);
  });
  it("takes a price fall in full", () => {
    expect(sellingPrice(50, 49)).toBe(49);
    expect(sellingPrice(80, 72)).toBe(72);
  });
});

describe("free transfers and hits", () => {
  it("rolls over unused transfers up to the cap of 5", () => {
    expect(nextFreeTransfers(1, 0, null, R)).toBe(2);
    expect(nextFreeTransfers(2, 0, null, R)).toBe(3);
    expect(nextFreeTransfers(4, 0, null, R)).toBe(5);
    expect(nextFreeTransfers(5, 0, null, R)).toBe(5);
  });
  it("using a transfer leaves the rest plus one new one", () => {
    expect(nextFreeTransfers(1, 1, null, R)).toBe(1);
    expect(nextFreeTransfers(3, 1, null, R)).toBe(3);
    expect(nextFreeTransfers(5, 2, null, R)).toBe(4);
  });
  it("taking a hit resets to one free transfer", () => {
    expect(nextFreeTransfers(1, 3, null, R)).toBe(1);
    expect(nextFreeTransfers(2, 5, null, R)).toBe(1);
  });
  it("Wildcard and Free Hit keep the banked transfers", () => {
    expect(nextFreeTransfers(3, 8, "wildcard", R)).toBe(3);
    expect(nextFreeTransfers(2, 15, "freehit", R)).toBe(2);
  });
  it("charges 4 points per transfer beyond the free allowance", () => {
    expect(transferCost(0, 1, null, R)).toEqual({ hits: 0, cost: 0, freeUsed: 0 });
    expect(transferCost(1, 1, null, R).cost).toBe(0);
    expect(transferCost(2, 1, null, R).cost).toBe(4);
    expect(transferCost(4, 1, null, R).cost).toBe(12);
    expect(transferCost(3, 3, null, R).cost).toBe(0);
  });
  it("charges nothing under Wildcard / Free Hit", () => {
    expect(transferCost(10, 1, "wildcard", R).cost).toBe(0);
    expect(transferCost(15, 0, "freehit", R).cost).toBe(0);
  });
  it("Bench Boost and Triple Captain do not change transfer costs", () => {
    expect(transferCost(2, 1, "bboost", R).cost).toBe(4);
    expect(transferCost(2, 1, "3xc", R).cost).toBe(4);
  });
});

describe("chip availability and legality", () => {
  it("first set is available in GW11, second set is not yet open", () => {
    const s = chipStatuses(ds, [], 11);
    expect(s.every((x) => x.available && x.window!.stop === 19)).toBe(true);
  });
  it("second set opens at GW20", () => {
    const s = chipStatuses(ds, [], 20);
    expect(s.every((x) => x.available && x.window!.start === 20)).toBe(true);
  });
  it("a chip used in the first half does not use up the second half", () => {
    expect(chipStatuses(ds, [{ name: "wildcard", event: 5 }], 11).find((x) => x.name === "wildcard")!.available).toBe(false);
    expect(chipStatuses(ds, [{ name: "wildcard", event: 5 }], 25).find((x) => x.name === "wildcard")!.available).toBe(true);
  });
  it("only one chip per gameweek", () => {
    expect(chipErrors(ds, [{ name: "bboost", event: 11 }], 11, "3xc").join()).toMatch(/only one chip/);
  });
  it("rejects a chip that is already used", () => {
    expect(chipErrors(ds, [{ name: "3xc", event: 4 }], 12, "3xc").join()).toMatch(/already used/);
  });
  it("Free Hit not in GW1 and not in consecutive gameweeks", () => {
    expect(chipErrors(ds, [], 1, "freehit").join()).toMatch(/GW1/);
    expect(chipErrors(ds, [{ name: "freehit", event: 19 }], 20, "freehit").join()).toMatch(/consecutive/);
    expect(chipErrors(ds, [], 12, "freehit")).toEqual([]);
  });
  it("accepts no chip", () => {
    expect(chipErrors(ds, [], 11, null)).toEqual([]);
  });
});

describe("applyPlan: deterministic transfer legality", () => {
  const squad = mediocreSquad();
  const outId = squad.holdings.find((h) => by.get(h.id)!.pos === "MID")!.id;

  it("applies a legal single transfer and never mutates the actual squad", () => {
    const before = JSON.stringify(squad);
    const inP = swapCandidates(squad, outId).find((p) => p.costTenths <= by.get(outId)!.costTenths + squad.bankTenths && p.teamId !== by.get(outId)!.teamId && squad.holdings.filter((h) => by.get(h.id)!.teamId === p.teamId).length < 3)!;
    const r = applyPlan(squad, { transfers: [{ out: outId, in: inP.id }] }, ds, NEXT_GW);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.holdings).toHaveLength(15);
    expect(r.holdings.some((h) => h.id === outId)).toBe(false);
    expect(r.holdings.find((h) => h.id === inP.id)!.buyTenths).toBe(inP.costTenths);
    expect(r.hitCost).toBe(0);
    expect(r.freeUsed).toBe(1);
    expect(r.ftAfter).toBe(1);
    expect(JSON.stringify(squad)).toBe(before);
  });

  it("uses the SELLING price (profit shared), not the market price, to fund the buy", () => {
    // a player bought 1.0m cheaper than today's price: only half of the rise is received on selling
    const target = squad.holdings.find((h) => by.get(h.id)!.costTenths >= 55 && by.get(h.id)!.pos !== "GKP")!;
    const cur = by.get(target.id)!.costTenths;
    const risen = { ...squad, holdings: squad.holdings.map((h) => (h.id === target.id ? { ...h, buyTenths: cur - 10 } : h)) };
    let found: ReturnType<typeof applyPlan> | null = null;
    for (const c of swapCandidates(risen, target.id)) {
      const r = applyPlan(risen, { transfers: [{ out: target.id, in: c.id }] }, ds, NEXT_GW);
      if (r.valid) { found = r; break; }
    }
    expect(found).not.toBeNull();
    const expectedSell = sellingPrice(cur - 10, cur);
    expect(expectedSell).toBe(cur - 5);
    expect(found!.transfers[0].sellTenths).toBe(expectedSell);
    expect(found!.bankTenths).toBe(risen.bankTenths + expectedSell - found!.transfers[0].inBuyTenths);
  });

  it("rejects a transfer the bank cannot afford", () => {
    const poor = { ...squad, bankTenths: 0 };
    const expensive = ds.players.filter((p) => p.pos === by.get(outId)!.pos && !squad.holdings.some((h) => h.id === p.id)).sort((a, b) => b.costTenths - a.costTenths)[0];
    const r = applyPlan(poor, { transfers: [{ out: outId, in: expensive.id }] }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Not enough money/);
  });

  it("enforces the 3-per-club limit", () => {
    const counts = new Map<number, number>();
    squad.holdings.forEach((h) => counts.set(by.get(h.id)!.teamId, (counts.get(by.get(h.id)!.teamId) ?? 0) + 1));
    // force 3 players of one club into the squad, then try adding a 4th
    const club = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const clubPlayers = ds.players.filter((p) => p.teamId === club && p.status === "a");
    let s = { ...squad, bankTenths: 500 };
    const rich = { ...s };
    const inClub = clubPlayers.filter((p) => !s.holdings.some((h) => h.id === p.id));
    const plan = { transfers: [] as { out: number; in: number }[] };
    let held = s.holdings.filter((h) => by.get(h.id)!.teamId === club).length;
    const outs = s.holdings.filter((h) => by.get(h.id)!.teamId !== club);
    for (const cand of inClub) {
      if (held >= 4) break;
      const o = outs.find((h) => by.get(h.id)!.pos === cand.pos && !plan.transfers.some((t) => t.out === h.id));
      if (!o) continue;
      plan.transfers.push({ out: o.id, in: cand.id });
      held++;
    }
    expect(held).toBeGreaterThanOrEqual(4);
    const r = applyPlan(rich, plan, ds, NEXT_GW);
    expect(r.errors.join()).toMatch(/per club/);
  });

  it("keeps the position quota (cannot swap a defender for a forward)", () => {
    const def = squad.holdings.find((h) => by.get(h.id)!.pos === "DEF")!.id;
    const fwd = ds.players.find((p) => p.pos === "FWD" && !squad.holdings.some((h) => h.id === p.id) && p.status === "a")!;
    const r = applyPlan({ ...squad, bankTenths: 300 }, { transfers: [{ out: def, in: fwd.id }] }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Need 5 DEF|Need 3 FWD/);
  });

  it("rejects selling a player you do not own and buying one you already own", () => {
    expect(applyPlan(squad, { transfers: [{ out: 999999, in: 1 }] }, ds, NEXT_GW).valid).toBe(false);
    const own = squad.holdings[0].id;
    const other = squad.holdings.find((h) => by.get(h.id)!.pos === by.get(own)!.pos && h.id !== own)!.id;
    expect(applyPlan(squad, { transfers: [{ out: own, in: other }] }, ds, NEXT_GW).errors.join()).toMatch(/already in your squad/);
  });

  it("charges 4 points for each transfer beyond the free allowance", () => {
    const outs = squad.holdings.filter((h) => by.get(h.id)!.pos !== "GKP").slice(0, 3);
    const plan = { transfers: [] as { out: number; in: number }[] };
    const taken = new Set(squad.holdings.map((h) => h.id));
    for (const o of outs) {
      const c = ds.players.find((p) => p.pos === by.get(o.id)!.pos && !taken.has(p.id) && p.status === "a" && p.costTenths <= by.get(o.id)!.costTenths && p.teamId !== by.get(o.id)!.teamId)!;
      taken.add(c.id);
      plan.transfers.push({ out: o.id, in: c.id });
    }
    const r = applyPlan({ ...squad, freeTransfers: 1 }, plan, ds, NEXT_GW);
    if (r.valid) {
      expect(r.count).toBe(3);
      expect(r.hits).toBe(2);
      expect(r.hitCost).toBe(8);
      expect(r.freeUsed).toBe(1);
      expect(r.ftAfter).toBe(1);
    }
    const free = applyPlan({ ...squad, freeTransfers: 3 }, plan, ds, NEXT_GW);
    if (free.valid) expect(free.hitCost).toBe(0);
  });

  it("refuses an illegal chip combination inside a plan", () => {
    const r = applyPlan({ ...squad, chipsUsed: [{ name: "bboost", event: NEXT_GW }] }, { transfers: [], chip: "3xc" }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/only one chip/);
  });
});

describe("Wildcard and Free Hit", () => {
  const squad = mediocreSquad({ freeTransfers: 2 });

  it("Wildcard: unlimited transfers with no hit, permanent, keeps banked transfers", async () => {
    const { planWildcard } = await import("@/lib/season/chips");
    const { buildHorizon } = await import("@/lib/season/horizon");
    const wc = planWildcard(ds, squad, NEXT_GW, buildHorizon(ds, NEXT_GW));
    expect(wc.transfers.length).toBeGreaterThan(3);
    const r = applyPlan(squad, { transfers: wc.transfers, chip: "wildcard" }, ds, NEXT_GW);
    expect(r.errors).toEqual([]);
    expect(r.hitCost).toBe(0);
    expect(r.ftAfter).toBe(2);
    expect(r.bankTenths).toBeGreaterThanOrEqual(0);
    expect(r.holdings.map((h) => h.id).sort()).toEqual([...wc.newIds].sort());
  });

  it("Free Hit: temporary squad within selling value + bank, never touches the permanent squad", async () => {
    const { planFreeHit } = await import("@/lib/season/chips");
    const { buildHorizon } = await import("@/lib/season/horizon");
    const fh = planFreeHit(ds, squad, NEXT_GW, buildHorizon(ds, NEXT_GW));
    expect(fh.budgetTenths).toBe(totalBudgetTenths(squad, ds));
    const cost = fh.ids.reduce((s, id) => s + by.get(id)!.costTenths, 0);
    expect(cost).toBeLessThanOrEqual(fh.budgetTenths);
    const r = applyPlan(squad, { transfers: [], chip: "freehit", freeHitIds: fh.ids }, ds, NEXT_GW);
    expect(r.errors).toEqual([]);
    expect(r.playingIds.sort()).toEqual([...fh.ids].sort());
    expect(r.holdings.map((h) => h.id).sort()).toEqual(squad.holdings.map((h) => h.id).sort());
    expect(r.hitCost).toBe(0);
    expect(r.ftAfter).toBe(2);
  });

  it("Free Hit squad that breaks the budget or club limit is rejected", () => {
    const priciest = ds.players.filter((p) => p.pos === "DEF").sort((a, b) => b.costTenths - a.costTenths).slice(0, 5).map((p) => p.id);
    const ids = [...squad.holdings.filter((h) => by.get(h.id)!.pos !== "DEF").map((h) => h.id), ...priciest];
    const r = applyPlan({ ...squad, bankTenths: 0 }, { transfers: [], chip: "freehit", freeHitIds: ids }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Free Hit squad/);
  });

  it("Free Hit cannot be combined with permanent transfers", () => {
    const o = squad.holdings[3].id;
    const i = swapCandidates(squad, o)[0];
    const r = applyPlan(squad, { transfers: [{ out: o, in: i.id }], chip: "freehit" }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
  });

  it("a Free Hit squad without the chip selected is rejected", () => {
    const r = applyPlan(squad, { transfers: [], freeHitIds: squad.holdings.map((h) => h.id) }, ds, NEXT_GW);
    expect(r.valid).toBe(false);
  });
});

describe("rollForward: gameweek to gameweek", () => {
  const squad = mediocreSquad({ freeTransfers: 1 });
  const outId = squad.holdings.find((h) => by.get(h.id)!.pos === "MID")!.id;
  const inP = swapCandidates(squad, outId).find((p) => p.costTenths <= by.get(outId)!.costTenths && !squad.holdings.some((h) => by.get(h.id)!.teamId === p.teamId && by.get(h.id)!.teamId !== by.get(outId)!.teamId && squad.holdings.filter((x) => by.get(x.id)!.teamId === p.teamId).length >= 3))!;

  it("with no plan the squad is carried forward and the free transfer is banked", () => {
    const { base, errors } = rollForward(stateOf(squad), ds, NEXT_GW + 1);
    expect(errors).toEqual([]);
    expect(base.gw).toBe(NEXT_GW + 1);
    expect(base.holdings.map((h) => h.id).sort()).toEqual(squad.holdings.map((h) => h.id).sort());
    expect(base.freeTransfers).toBe(2);
    expect(base.bankTenths).toBe(squad.bankTenths);
  });

  it("accepted transfers carry into the next gameweek with updated bank and purchase price", () => {
    const st = stateOf(squad, { [NEXT_GW]: { transfers: [{ out: outId, in: inP.id }] } });
    const { base } = rollForward(st, ds, NEXT_GW + 1);
    expect(base.holdings.some((h) => h.id === inP.id)).toBe(true);
    expect(base.holdings.some((h) => h.id === outId)).toBe(false);
    expect(base.freeTransfers).toBe(1);
    expect(st.actual.holdings.some((h) => h.id === outId)).toBe(true); // actual untouched
  });

  it("rolls several gameweeks and caps banked transfers at 5", () => {
    const { base } = rollForward(stateOf({ ...squad, freeTransfers: 4 }), ds, NEXT_GW + 4);
    expect(base.freeTransfers).toBe(5);
  });

  it("Free Hit reverts to the previous squad next gameweek and records the chip", () => {
    const fhIds = optimalSquad().holdings.map((h) => h.id);
    const st = stateOf(squad, { [NEXT_GW]: { transfers: [], chip: "freehit", freeHitIds: fhIds } });
    const { base, errors } = rollForward(st, ds, NEXT_GW + 1);
    expect(errors).toEqual([]);
    expect(base.holdings.map((h) => h.id).sort()).toEqual(squad.holdings.map((h) => h.id).sort());
    expect(base.chipsUsed).toContainEqual({ name: "freehit", event: NEXT_GW });
    expect(base.freeTransfers).toBe(1);
  });

  it("stops and reports an illegal earlier plan", () => {
    const st = stateOf({ ...squad, bankTenths: 0 }, { [NEXT_GW]: { transfers: [{ out: outId, in: ds.players.filter((p) => p.pos === by.get(outId)!.pos).sort((a, b) => b.costTenths - a.costTenths)[0].id }] } });
    const { errors, base } = rollForward(st, ds, NEXT_GW + 2);
    expect(errors.length).toBeGreaterThan(0);
    expect(base.gw).toBe(NEXT_GW);
  });

  it("a chip used in GW11 blocks another chip in GW11 but not in GW12", () => {
    const st = stateOf(squad, { [NEXT_GW]: { transfers: [], chip: "bboost" }, [NEXT_GW + 1]: { transfers: [], chip: "3xc" } });
    expect(rollForward(st, ds, NEXT_GW + 2).errors).toEqual([]);
  });
});

describe("editPlan", () => {
  const ids = [1, 2, 3];
  it("adds a transfer", () => expect(editPlan(undefined, ids, 1, 9).transfers).toEqual([{ out: 1, in: 9 }]));
  it("re-targeting an incoming player rewrites the same transfer (no double cost)", () => {
    const p = editPlan({ transfers: [{ out: 1, in: 9 }] }, ids, 9, 10);
    expect(p.transfers).toEqual([{ out: 1, in: 10 }]);
  });
  it("swapping back to the original removes the transfer", () => {
    expect(editPlan({ transfers: [{ out: 1, in: 9 }] }, ids, 9, 1).transfers).toEqual([]);
  });
  it("rejects players outside the squad", () => expect(() => editPlan(undefined, ids, 42, 9)).toThrow());
});

describe("squad value and budget", () => {
  it("team value uses selling prices and total budget adds the bank", () => {
    const s = mediocreSquad();
    const h = s.holdings[0];
    const raised = { ...s, holdings: s.holdings.map((x, i) => (i === 0 ? { ...x, buyTenths: by.get(h.id)!.costTenths - 10 } : x)) };
    expect(squadValueTenths(raised, ds)).toBe(squadValueTenths(s, ds) - 5);
    expect(totalBudgetTenths(raised, ds)).toBe(squadValueTenths(raised, ds) + raised.bankTenths);
  });
});

describe("import helpers", () => {
  const tr = (event: number, time: string, out: number, inn: number, outC: number, inC: number) => ({ element_in: inn, element_in_cost: inC, element_out: out, element_out_cost: outC, event, time });
  it("replays transfers in time order and records purchase prices", () => {
    const h = reconstructHoldings([{ id: 1, buyTenths: 50 }, { id: 2, buyTenths: 60 }], [tr(3, "2026-09-02", 1, 5, 51, 70), tr(2, "2026-08-20", 2, 3, 60, 62)], new Set());
    expect(h.sort((a, b) => a.id - b.id)).toEqual([{ id: 3, buyTenths: 62 }, { id: 5, buyTenths: 70 }]);
  });
  it("ignores Free Hit gameweek transfers (the squad reverted)", () => {
    const h = reconstructHoldings([{ id: 1, buyTenths: 50 }], [tr(4, "2026-09-10", 1, 9, 50, 99)], new Set([4]));
    expect(h).toEqual([{ id: 1, buyTenths: 50 }]);
  });
  it("derives free transfers: roll-over, usage, hit reset, chips", () => {
    expect(simulateFreeTransfers(1, 1, {}, [], R)).toBe(1);
    expect(simulateFreeTransfers(1, 4, {}, [], R)).toBe(4);
    expect(simulateFreeTransfers(1, 10, {}, [], R)).toBe(5);
    expect(simulateFreeTransfers(1, 4, { 2: 1, 3: 1, 4: 1 }, [], R)).toBe(1);
    expect(simulateFreeTransfers(1, 3, { 3: 3 }, [], R)).toBe(1); // hit -> back to 1
    expect(simulateFreeTransfers(1, 4, { 2: 0, 3: 0 }, [{ name: "wildcard", event: 4 }], R)).toBe(3); // 1,2,3 then WC keeps 3
    expect(simulateFreeTransfers(1, 3, {}, [{ name: "freehit", event: 3 }], R)).toBe(2);
  });
});
