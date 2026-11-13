import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectAll } from "@/lib/analytics/playerScoring";
import type { Dataset, Player } from "@/lib/fpl/types";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";
import { validateLineup, validateSquad } from "@/lib/optimizer/validation";
import { buildHorizon } from "@/lib/season/horizon";
import { applyPlan } from "@/lib/season/squad";
import { analyseTransfers } from "@/lib/season/transfers";
import { SEASON_LONG, availabilityTrajectory, buildSeasonHorizon, describeSeasonLong, optimizeSeasonLong, seasonLongSummary, seasonLongTransfers, seasonValues, SeasonLongError } from "@/lib/strategies/seasonLong";
import { NEXT_GW } from "./helpers";
import { by, ds, squadFrom } from "./seasonHelpers";

vi.mock("@/lib/fpl/client", () => ({ getDataset: async () => (await import("./helpers")).sampleDataset(), getElementSummary: async () => null }));

const hz = buildSeasonHorizon(ds, NEXT_GW);
const vals = seasonValues(ds, hz);
const sl = optimizeSeasonLong(ds, hz);
const find = (n: string) => ds.players.find((p) => p.webName === n)!;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("remaining-season horizon", () => {
  it("runs from the selected gameweek to GW38 by default and can end earlier", () => {
    expect(hz.gws[0]).toBe(NEXT_GW);
    expect(hz.gws.at(-1)).toBe(38);
    expect(hz.gws).toHaveLength(28);
    expect(hz.proj).toHaveLength(28);
    expect(buildSeasonHorizon(ds, NEXT_GW, { endGw: 20 }).gws).toHaveLength(10);
    expect(buildSeasonHorizon(ds, NEXT_GW, { endGw: 99 }).endGw).toBe(38);
    expect(buildSeasonHorizon(ds, 30).gws).toHaveLength(9);
  });
  it("uses a genuine time discount: weights fall every gameweek and later gameweeks matter less", () => {
    for (let j = 1; j < hz.weights.length; j++) expect(hz.weights[j]).toBeLessThan(hz.weights[j - 1]);
    expect(hz.weights[0]).toBe(1);
    expect(hz.weights[27]).toBeCloseTo(Math.pow(SEASON_LONG.discount, 27), 8);
    expect(hz.discountSum).toBeCloseTo(hz.weights.reduce((a, b) => a + b, 0), 8);
    expect(hz.discountSum).toBeLessThan(28);
    expect(hz.discountSum).toBeGreaterThan(10);
  });
  it("is not the next five gameweeks multiplied up", () => {
    const h = find("Haaland");
    const hz5 = buildHorizon(ds, NEXT_GW);
    const fiveRaw = hz5.proj.reduce((a, m) => a + m.get(h.id)!.ep, 0);
    const v = vals.get(h.id)!;
    expect(v.rawSeason).not.toBeCloseTo((fiveRaw * 28) / 5, 0);
    expect(v.value).toBeLessThan(v.rawSeason); // discounting
    expect(v.value).not.toBeCloseTo(v.rawSeason * (hz.discountSum / 28), 1); // per-gameweek variation, not a flat average
    // a change in a DISTANT gameweek moves the value less than the same change in the next gameweek
    const bump = (j: number) => { const c = buildSeasonHorizon(ds, NEXT_GW); const p = c.proj[j].get(h.id)!; c.proj[j].set(h.id, { ...p, ep: p.ep + 2 }); return seasonValues(ds, c).get(h.id)!.value - v.value; };
    expect(bump(0)).toBeGreaterThan(bump(20) * 3);
  });
  it("keeps fixture counts: blank gameweeks project 0 and double gameweeks about double", () => {
    const h = find("Haaland");
    const fx = ds.fixtures.find((f) => f.event === 20 && (f.teamH === h.teamId || f.teamA === h.teamId))!;
    const dgw: Dataset = { ...ds, fixtures: [...ds.fixtures, { ...fx, id: 99999 }] };
    const base = buildSeasonHorizon(ds, NEXT_GW);
    const dbl = buildSeasonHorizon(dgw, NEXT_GW);
    const j = 20 - NEXT_GW;
    expect(dbl.proj[j].get(h.id)!.fixtures).toHaveLength(2);
    expect(dbl.proj[j].get(h.id)!.ep / base.proj[j].get(h.id)!.ep).toBeGreaterThan(1.8);
    const blank: Dataset = { ...ds, fixtures: ds.fixtures.filter((f) => !(f.event === 20 && (f.teamH === h.teamId || f.teamA === h.teamId))) };
    expect(buildSeasonHorizon(blank, NEXT_GW).proj[j].get(h.id)!.ep).toBe(0);
  });
  it("fixture difficulty over the season matters: an easier run raises value", () => {
    const p = find("Tavernier");
    const easy: Dataset = { ...ds, fixtures: ds.fixtures.map((f) => (f.event && f.event > NEXT_GW && f.event < 30 && (f.teamH === p.teamId || f.teamA === p.teamId) ? { ...f, diffH: 1, diffA: 1 } : f)) };
    expect(buildSeasonHorizon(easy, NEXT_GW).gws).toHaveLength(28); // FDR is display-only; the model uses measured strength
    const weakOpp: Dataset = { ...ds, teams: { ...ds.teams } };
    const opps = new Set(ds.fixtures.filter((f) => f.event && f.event > NEXT_GW && (f.teamH === p.teamId || f.teamA === p.teamId)).map((f) => (f.teamH === p.teamId ? f.teamA : f.teamH)));
    for (const o of opps) weakOpp.teams[o] = { ...ds.teams[o], goalsAgainst: ds.teams[o].goalsAgainst * 2.5, xGAgainst: ds.teams[o].xGAgainst * 2.5 };
    const v = seasonValues(weakOpp, buildSeasonHorizon(weakOpp, NEXT_GW)).get(p.id)!.value;
    expect(v).toBeGreaterThan(vals.get(p.id)!.value);
  });
  it("fixture blending parameter flattens distant fixture swings (rho < 1 reduces variation)", () => {
    const flat = buildSeasonHorizon(ds, NEXT_GW, { params: { fixtureTrust: 0.9 } });
    const h = find("Haaland");
    const sd = (x: SeasonHorizonLike) => { const e = x.proj.map((m) => m.get(h.id)!.ep); const mu = e.reduce((a, b) => a + b, 0) / e.length; return Math.sqrt(e.reduce((a, b) => a + (b - mu) ** 2, 0) / e.length); };
    type SeasonHorizonLike = typeof hz;
    expect(sd(flat)).toBeLessThan(sd(hz));
  });
});

describe("availability and injury risk", () => {
  const mk = (over: Partial<Player>): Player => ({ ...find("Haaland"), ...over });
  it("fit players start at 100% and settle at the calibrated haircut", () => {
    const fit = mk({ status: "a", chanceNext: null });
    expect(availabilityTrajectory(fit, 0)).toBe(1);
    expect(availabilityTrajectory(fit, 40)).toBeCloseTo(1 - SEASON_LONG.futureAbsence, 3);
    for (let j = 1; j < 10; j++) expect(availabilityTrajectory(fit, j)).toBeLessThanOrEqual(availabilityTrajectory(fit, j - 1) + 1e-9);
  });
  it("injured players start at their chance of playing and recover over time, slower than doubtful ones", () => {
    const inj = mk({ status: "i", chanceNext: 0 });
    const dbt = mk({ status: "d", chanceNext: 25 });
    expect(availabilityTrajectory(inj, 0)).toBe(0);
    for (let j = 1; j < 30; j++) expect(availabilityTrajectory(inj, j)).toBeGreaterThanOrEqual(availabilityTrajectory(inj, j - 1));
    expect(availabilityTrajectory(inj, 30)).toBeGreaterThan(0.8);
    expect(availabilityTrajectory(dbt, 3)).toBeGreaterThan(availabilityTrajectory(inj, 3));
    expect(availabilityTrajectory(mk({ status: "s", chanceNext: null }), 0)).toBe(0);
  });
  it("unavailable or not-in-squad players stay at zero", () => {
    expect(availabilityTrajectory(mk({ status: "u" }), 10)).toBe(0);
    expect(availabilityTrajectory(mk({ status: "n" }), 10)).toBe(0);
  });
  it("a currently injured star is worth less than a fit equivalent, but recovers value later in the season", () => {
    const star = find("Haaland");
    const hurt: Dataset = { ...ds, players: ds.players.map((p) => (p.id === star.id ? { ...p, status: "i", chanceNext: 0 } : p)) };
    const hh = buildSeasonHorizon(hurt, NEXT_GW);
    const v = seasonValues(hurt, hh).get(star.id)!;
    expect(v.value).toBeLessThan(vals.get(star.id)!.value);
    expect(hh.proj[0].get(star.id)!.ep).toBe(0);
    expect(hh.proj[25].get(star.id)!.ep).toBeGreaterThan(hz.proj[25].get(star.id)!.ep * 0.7);
  });
});

describe("squad optimiser", () => {
  it("returns a legal 15-man squad within £100m, 3 per club, with a legal XI, four subs and independent captaincy", () => {
    expect(sl.squad).toHaveLength(15);
    expect(validateSquad(sl.squad, by, ds.rules, 1000).errors).toEqual([]);
    expect(sl.totalCostTenths).toBeLessThanOrEqual(1000);
    expect(sl.totalCostTenths + sl.remainingTenths).toBe(1000);
    expect(validateLineup({ starting: sl.starting, bench: sl.bench, formation: sl.formation, captain: sl.captain, viceCaptain: sl.viceCaptain }, sl.squad, by, ds.rules).errors).toEqual([]);
    expect(sl.starting).toHaveLength(11);
    expect(sl.bench).toHaveLength(4);
    expect(by.get(sl.bench[0])!.pos).toBe("GKP"); // goalkeeper first, then outfield
    expect(sl.bench.slice(1).every((id) => by.get(id)!.pos !== "GKP")).toBe(true);
    const top = [...sl.starting].sort((a, b) => hz.display.get(b)!.ep - hz.display.get(a)!.ep)[0];
    expect(sl.captain).toBe(top);
    expect(sl.viceCaptain).not.toBe(sl.captain);
  });
  it("is deterministic", () => {
    expect(optimizeSeasonLong(ds, buildSeasonHorizon(ds, NEXT_GW)).squad).toEqual(sl.squad);
  });
  it("honours a preferred formation, a custom budget and an ownership cap", () => {
    for (const f of ["4-4-2", "3-5-2", "5-3-2"]) expect(optimizeSeasonLong(ds, hz, { formation: f }).formation).toBe(f);
    const cheap = optimizeSeasonLong(ds, hz, { budgetTenths: 920 });
    expect(cheap.totalCostTenths).toBeLessThanOrEqual(920);
    const capped = optimizeSeasonLong(ds, hz, { maxOwnership: 15 });
    for (const id of capped.squad) expect(by.get(id)!.ownership).toBeLessThanOrEqual(15);
    expect(validateSquad(capped.squad, by, ds.rules, 1000).valid).toBe(true);
  });
  it("rejects impossible constraints and malformed formations", () => {
    expect(() => optimizeSeasonLong(ds, hz, { budgetTenths: 400 })).toThrow(SeasonLongError);
    expect(() => optimizeSeasonLong(ds, hz, { formation: "9-9-9x" })).toThrow(SeasonLongError);
  });
  it("builds a core of secure, fit starters and a playable bench; never an unavailable player", () => {
    for (const id of sl.coreXI) { expect(vals.get(id)!.startProb).toBeGreaterThanOrEqual(SEASON_LONG.xiMinStartProb); expect(vals.get(id)!.availability0).toBeGreaterThanOrEqual(SEASON_LONG.xiMinAvailability); }
    for (const id of sl.squad) { expect(["u", "n"]).not.toContain(by.get(id)!.status); expect(vals.get(id)!.availability0).toBeGreaterThanOrEqual(SEASON_LONG.minAvailability); }
    for (const id of sl.bench.filter((i) => by.get(i)!.pos !== "GKP")) expect(vals.get(id)!.startProb).toBeGreaterThanOrEqual(SEASON_LONG.benchMinStartProb);
  });
  it("is a long-horizon optimiser: highest rest-of-season value, lowest immediate xPts trade-off versus Balanced", () => {
    const { byId } = projectAll(ds, NEXT_GW, { mode: "balanced" });
    const bal = optimizeSquad(ds, byId, { mode: "balanced" }).result;
    const slSum = seasonLongSummary(ds, hz, vals, { starting: sl.starting, bench: sl.bench, captain: sl.captain });
    const balSum = seasonLongSummary(ds, hz, vals, { starting: bal.starting, bench: bal.bench, captain: bal.captain });
    expect(slSum.xiRestOfSeasonDiscounted).toBeGreaterThanOrEqual(balSum.xiRestOfSeasonDiscounted - 1e-6);
    expect(slSum.squad15RestOfSeasonDiscounted).toBeGreaterThanOrEqual(balSum.squad15RestOfSeasonDiscounted - 1e-6);
    expect(bal.expectedPoints).toBeGreaterThanOrEqual(sl.expectedPoints - 1e-6); // Balanced remains the short-horizon optimiser
    expect(sl.squad.filter((i) => ![...bal.starting, ...bal.bench].includes(i)).length).toBeGreaterThan(2);
  });
  it("leaves the existing strategies untouched (pinned Balanced output)", () => {
    const { byId } = projectAll(ds, NEXT_GW, { mode: "balanced" });
    const r = optimizeSquad(ds, byId, { mode: "balanced" }).result;
    expect({ starting: r.starting, bench: r.bench, captain: r.captain, cost: r.totalCostTenths, ep: r.expectedPoints }).toEqual({ starting: [385, 112, 60, 4, 566, 68, 183, 542, 411, 379, 166], bench: [496, 45, 124, 504], captain: 411, cost: 998, ep: 57.14 });
  });
});

describe("explanations and totals", () => {
  const rows = describeSeasonLong(ds, hz, vals, { starting: sl.starting, bench: sl.bench, captain: sl.captain, vice: sl.viceCaptain, coreXI: sl.coreXI });
  it("gives every player price, next-gameweek xPts, rest-of-season xPts, minutes, start probability and a reason", () => {
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      expect(r.priceM).toBeGreaterThan(3.9);
      expect(Number.isFinite(r.xptsNextGw)).toBe(true);
      expect(r.xptsRestOfSeasonRaw).toBeGreaterThan(0);
      expect(r.xptsRestOfSeasonDiscounted).toBeLessThan(r.xptsRestOfSeasonRaw);
      expect(r.expMinutes).toBeGreaterThanOrEqual(0);
      expect(r.startProb).toBeGreaterThanOrEqual(0);
      expect(r.reasons.length).toBeGreaterThan(2);
      expect(r.reasons.join(" ")).toMatch(/Rest-of-season value/);
    }
    expect(rows.filter((r) => r.isCaptain)).toHaveLength(1);
  });
  it("explains why each substitute is on the bench, and never contradicts the numbers", () => {
    const bench = rows.filter((r) => r.role === "bench");
    expect(bench).toHaveLength(4);
    const starters = rows.filter((r) => r.role === "starting");
    for (const b of bench) {
      expect(b.benchReason!.length).toBeGreaterThan(40);
      if (b.pos === "GKP") { expect(b.benchReason).toMatch(/Substitute goalkeeper/); continue; }
      const weakest = starters.filter((s) => s.pos === b.pos).sort((x, y) => x.xptsRestOfSeasonDiscounted - y.xptsRestOfSeasonDiscounted)[0];
      if (weakest && b.xptsRestOfSeasonDiscounted >= weakest.xptsRestOfSeasonDiscounted) expect(b.benchReason).toMatch(/Benched this gameweek/);
      else expect(b.benchReason).toMatch(/Bench cover/);
    }
  });
  it("reports totals for the starting XI and the full 15-player squad, this gameweek and over the remaining season", () => {
    const s = seasonLongSummary(ds, hz, vals, { starting: sl.starting, bench: sl.bench, captain: sl.captain });
    expect(s.xiThisGw).toBeCloseTo(sl.expectedPoints, 1);
    expect(s.squad15ThisGw).toBeGreaterThan(s.xiThisGw - 20);
    expect(s.xiRestOfSeasonRaw).toBeGreaterThan(s.xiRestOfSeasonDiscounted);
    expect(s.squad15RestOfSeasonRaw).toBeGreaterThan(s.xiRestOfSeasonRaw);
    expect(s.perGwXi).toHaveLength(28);
    expect(s.gameweeks).toBe(28);
  });
});

describe("weekly transfer workflow", () => {
  const strong = squadFrom(sl.squad, { freeTransfers: 1 });
  const weak = squadFrom(optimizeSquad(ds, new Map([...projectAll(ds, NEXT_GW).byId].map(([id, p]) => [id, { ...p, score: by.get(id)!.form, ep: by.get(id)!.form }])), { mode: "balanced", budgetTenths: 980 }).result.squad, { freeTransfers: 1, bankTenths: 25 });
  it("rolls the transfer when its own squad has no worthwhile move; never forces a transfer", () => {
    const a = seasonLongTransfers(ds, strong, NEXT_GW, hz);
    expect(a.action).toBe("save");
    expect(a.recommendedN).toBe(0);
    expect(a.headline.toLowerCase()).toContain("save");
  });
  it("finds a worthwhile move on a weaker squad, with remaining-season gains and explanations", () => {
    const a = seasonLongTransfers(ds, weak, NEXT_GW, hz);
    expect(["transfer", "hit"]).toContain(a.action);
    const best = a.options[a.recommendedN];
    expect(best.net).toBeGreaterThan(0);
    expect(best.gainRemainingSeasonRaw).toBeGreaterThan(0);
    expect(best.gainRemainingSeasonRaw).toBeGreaterThan(best.gainHorizon); // undiscounted > discounted
    const tr = best.transfers as (typeof best.transfers[number] & { gainRemainingSeasonRaw: number })[];
    tr.forEach((t) => { expect(t.explanation.length).toBeGreaterThan(30); expect(t.gainRemainingSeasonRaw).toBeDefined(); });
    expect(tr.reduce((s, t) => s + t.gainRemainingSeasonRaw, 0)).toBeCloseTo(best.gainRemainingSeasonRaw, 1);
    expect(a.horizonGws).toHaveLength(28);
    expect(a.horizon.to).toBe(38);
    expect(a.reason).toMatch(/28 GWs/);
  });
  it("every recommended plan is legal under the FPL rules engine and respects free transfers, hits, bank and selling prices", () => {
    const a = seasonLongTransfers(ds, weak, NEXT_GW, hz);
    for (const o of a.options) {
      const r = applyPlan(weak, { transfers: o.transfers.map((t) => ({ out: t.out, in: t.in })) }, ds, NEXT_GW);
      expect(r.errors, `option ${o.n}`).toEqual([]);
      expect(r.hitCost).toBe(o.hitCost);
      expect(r.hitCost).toBe(Math.max(0, o.n - 1) * 4);
      expect(r.bankTenths).toBeGreaterThanOrEqual(0);
      expect(o.net).toBeCloseTo(o.gainHorizon - o.hitCost, 1);
    }
    const five = seasonLongTransfers(ds, { ...weak, freeTransfers: 5 }, NEXT_GW, hz);
    expect(five.options.find((o) => o.n === 3)!.hitCost).toBe(0);
  });
  it("scales its decision thresholds to the longer horizon (no more eager than the default engine would be)", () => {
    const scale = hz.discountSum / 4;
    expect(scale).toBeGreaterThan(2);
    const unscaled = analyseTransfers(ds, strong, NEXT_GW, hz);
    const scaled = analyseTransfers(ds, strong, NEXT_GW, hz, { edgeScale: scale, bankScale: scale });
    expect(scaled.options[0].score).toBeGreaterThan(unscaled.options[0].score); // banking is worth more on this scale
    expect(analyseTransfers(ds, weak, NEXT_GW, hz, { edgeScale: 1, bankScale: 1 }).options.map((o) => o.score)).toEqual(analyseTransfers(ds, weak, NEXT_GW, hz).options.map((o) => o.score));
  });
  it("the existing five-gameweek transfer engine is unchanged by the new options", () => {
    const hz5 = buildHorizon(ds, NEXT_GW);
    const a = analyseTransfers(ds, weak, NEXT_GW, hz5);
    const b = analyseTransfers(ds, weak, NEXT_GW, hz5, {});
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.options.length).toBeGreaterThan(2);
    expect(a.reason).toMatch(/5 GWs/);
  });
});

describe("Season Long API", () => {
  let route: typeof import("@/app/api/strategies/season-long/route");
  beforeAll(async () => { route = await import("@/app/api/strategies/season-long/route"); });
  it("returns the same squad shape as the other strategies plus remaining-season details", async () => {
    const res = await route.POST(post({ gw: NEXT_GW }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.strategy).toBe("season-long");
    expect(j.starting).toHaveLength(11);
    expect(j.bench).toHaveLength(4);
    expect(j.squadIds).toEqual(sl.squad);
    expect(j.expectedPoints).toBeCloseTo(sl.expectedPoints, 1);
    expect(j.seasonLong.horizon).toMatchObject({ from: 11, to: 38, gameweeks: 28 });
    expect(j.seasonLong.rows).toHaveLength(15);
    expect(j.seasonLong.summary.xiRestOfSeasonRaw).toBeGreaterThan(1000);
    expect(j.seasonLong.horizon.limitations.length).toBeGreaterThan(3);
    expect(j.totalCost + j.remaining).toBeCloseTo(100, 5);
  });
  it("accepts budget, formation, ownership cap and a shorter horizon; validates input", async () => {
    const ok = await (await route.POST(post({ gw: NEXT_GW, formation: "4-4-2", budget: 95, maxOwnership: 30, horizonEnd: 25 }))).json();
    expect(ok.formation).toBe("4-4-2");
    expect(ok.totalCost).toBeLessThanOrEqual(95);
    expect(ok.seasonLong.horizon.gameweeks).toBe(15);
    expect((await route.POST(post({ gw: NEXT_GW, horizonEnd: 5 }))).status).toBe(400);
    expect((await route.POST(post({ gw: NEXT_GW, horizonEnd: 99 }))).status).toBe(400);
    expect((await route.POST(post({ gw: NEXT_GW, horizonEnd: 2.5 }))).status).toBe(400);
    expect((await route.POST(post({ gw: NEXT_GW, formation: "abc" }))).status).toBe(400);
    expect((await route.POST(post({ gw: 77 }))).status).toBe(400);
    const bad = await route.POST(post({ gw: NEXT_GW, budget: 40 }));
    expect(bad.status).toBe(422);
  });
  it("describes an edited squad exactly as given and rejects illegal ones", async () => {
    const { POST } = await import("@/app/api/strategies/season-long/players/route");
    const body = { gw: NEXT_GW, starting: sl.starting, bench: sl.bench, captain: sl.captain, vice: sl.viceCaptain };
    const j = await (await POST(post(body))).json();
    expect(j.rows.map((r: { id: number }) => r.id)).toEqual([...sl.starting, ...sl.bench]);
    expect((await POST(post({ ...body, captain: sl.bench[0] }))).status).toBe(422);
    expect((await POST(post({ ...body, starting: sl.starting.slice(1) }))).status).toBe(400);
  });
  it("weekly transfers route returns the recommendation with remaining-season gains and player data", async () => {
    const { POST } = await import("@/app/api/strategies/season-long/transfers/route");
    const j = await (await POST(post({ season: { actual: weakActual(), plans: {} }, gw: NEXT_GW }))).json();
    expect(["save", "transfer", "hit"]).toContain(j.action);
    expect(j.horizon.to).toBe(38);
    expect(j.options.length).toBeGreaterThan(2);
    expect(j.options[1].gainRemainingSeasonRaw).toBeDefined();
    expect(Object.keys(j.players).length).toBeGreaterThan(5);
    expect((await POST(post({ season: { actual: weakActual() }, gw: NEXT_GW, horizonEnd: 3 }))).status).toBe(400);
  });
});

function weakActual() {
  return squadFrom(optimizeSquad(ds, new Map([...projectAll(ds, NEXT_GW).byId].map(([id, p]) => [id, { ...p, score: by.get(id)!.form, ep: by.get(id)!.form }])), { mode: "balanced", budgetTenths: 980 }).result.squad, { freeTransfers: 1, bankTenths: 25 });
}
