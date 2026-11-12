import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NEXT_GW } from "./helpers";
import { by, ds, mediocreSquad, swapCandidates } from "./seasonHelpers";

vi.mock("@/lib/fpl/client", () => ({
  getDataset: async () => (await import("./helpers")).sampleDataset(),
  getElementSummary: async (id: number) => {
    const { sampleDataset } = await import("./helpers");
    const p = sampleDataset().players.find((x) => x.id === id)!;
    return { history: [{ round: 1, value: p.costTenths - 2 }] };
  },
}));

const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const squad = mediocreSquad({ freeTransfers: 1 });
const season = { source: "manual", actual: squad, plans: {} };
afterEach(() => vi.unstubAllGlobals());

describe("season API", () => {
  it("POST /api/season/evaluate: base == proposed with no plan, actual untouched", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    const body = await (await POST(post({ season, gw: NEXT_GW }))).json();
    expect(body.base.freeTransfers).toBe(1);
    expect(body.base.holdings).toHaveLength(15);
    expect(body.plan.valid).toBe(true);
    expect(body.plan.hitCost).toBe(0);
    expect(body.proposed.starting).toHaveLength(11);
    expect(body.proposed.expectedPoints).toBeCloseTo(body.base.expectedPoints, 1);
    expect(body.base.chips).toHaveLength(4);
    expect(body.base.valueTenths + body.base.bankTenths).toBe(body.base.totalBudgetTenths);
  });

  it("evaluate applies a plan: bank, hit and expected-point delta come from the rules engine", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    const { POST: alt } = await import("@/app/api/season/alternatives/route");
    const out = squad.holdings.find((h) => by.get(h.id)!.pos === "FWD")!.id;
    const a = await (await alt(post({ season, gw: NEXT_GW, playerId: out }))).json();
    const best = a.alternatives[0];
    const plan = { transfers: [{ out, in: best.playerId }] };
    const body = await (await POST(post({ season: { ...season, plans: { [NEXT_GW]: plan } }, gw: NEXT_GW }))).json();
    expect(body.plan.valid).toBe(true);
    expect(body.plan.count).toBe(1);
    expect(body.plan.hitCost).toBe(0);
    expect(body.plan.bankTenths).toBe(best.bankAfterTenths);
    expect(body.proposed.deltaVsBase).toBeCloseTo(best.deltaEpGw, 1);
    expect(body.proposed.remaining).toBeCloseTo(best.bankAfterTenths / 10, 5);
  });

  it("evaluate reports illegal plans without throwing", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    const out = squad.holdings.find((h) => by.get(h.id)!.pos === "MID")!.id;
    const pricey = ds.players.filter((p) => p.pos === "MID").sort((a, b) => b.costTenths - a.costTenths)[0];
    const res = await POST(post({ season: { ...season, actual: { ...squad, bankTenths: 0 }, plans: { [NEXT_GW]: { transfers: [{ out, in: pricey.id }] } } }, gw: NEXT_GW }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.plan.valid).toBe(false);
    expect(body.plan.errors.join()).toMatch(/Not enough money/);
  });

  it("carry forward: planning GW12 includes the accepted GW11 transfer and rolled free transfers", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    const out = squad.holdings.find((h) => by.get(h.id)!.pos === "MID")!.id;
    const inn = swapCandidates(squad, out).find((c) => c.costTenths <= by.get(out)!.costTenths && squad.holdings.filter((h) => by.get(h.id)!.teamId === c.teamId).length < 3)!;
    const body = await (await POST(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: [{ out, in: inn.id }] } } }, gw: NEXT_GW + 1 }))).json();
    expect(body.rollErrors).toEqual([]);
    expect(body.gw).toBe(NEXT_GW + 1);
    expect(body.base.holdings.some((h: any) => h.id === inn.id)).toBe(true);
    expect(body.base.freeTransfers).toBe(1);
  });

  it("rejects planning in the past and malformed state", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    expect((await POST(post({ season, gw: NEXT_GW - 1 }))).status).toBe(400);
    expect((await POST(post({ gw: NEXT_GW }))).status).toBe(400);
    expect((await POST(post({ season: { actual: { gw: 11, holdings: [{ id: "x" }] } } }))).status).toBe(400);
  });

  it("POST /api/season/transfers returns options, a decision and sell lists with player data", async () => {
    const { POST } = await import("@/app/api/season/transfers/route");
    const body = await (await POST(post({ season, gw: NEXT_GW }))).json();
    expect(body.options.length).toBeGreaterThan(2);
    expect(["save", "transfer", "hit"]).toContain(body.action);
    expect(body.sellCandidates).toHaveLength(15);
    const t = body.options[1].transfers[0];
    expect(body.players[t.out].name).toBeTruthy();
    expect(body.players[t.in].name).toBeTruthy();
    expect(body.horizonGws).toHaveLength(5);
  });

  it("POST /api/season/chips returns advice for each chip", async () => {
    const { POST } = await import("@/app/api/season/chips/route");
    const body = await (await POST(post({ season, gw: NEXT_GW }))).json();
    expect(body.advice).toHaveLength(4);
  });

  it("freehit / wildcard planners produce plans the engine accepts", async () => {
    const { POST: fh } = await import("@/app/api/season/freehit/route");
    const { POST: wc } = await import("@/app/api/season/wildcard/route");
    const { POST: ev } = await import("@/app/api/season/evaluate/route");
    const f = await (await fh(post({ season, gw: NEXT_GW }))).json();
    const e1 = await (await ev(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: [], chip: "freehit", freeHitIds: f.ids } } }, gw: NEXT_GW }))).json();
    expect(e1.plan.valid).toBe(true);
    expect(e1.plan.freeHitIds).toHaveLength(15);
    expect(e1.plan.permanentIds.sort()).toEqual(squad.holdings.map((h) => h.id).sort());
    const w = await (await wc(post({ season, gw: NEXT_GW }))).json();
    const e2 = await (await ev(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: w.transfers, chip: "wildcard" } } }, gw: NEXT_GW }))).json();
    expect(e2.plan.valid).toBe(true);
    expect(e2.plan.hitCost).toBe(0);
    const used = await fh(post({ season: { ...season, actual: { ...squad, chipsUsed: [{ name: "freehit", event: 5 }] } }, gw: NEXT_GW }));
    expect(used.status).toBe(422);
  });

  it("Bench Boost and Triple Captain raise projected points via the chip rules", async () => {
    const { POST } = await import("@/app/api/season/evaluate/route");
    const none = await (await POST(post({ season, gw: NEXT_GW }))).json();
    const bb = await (await POST(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: [], chip: "bboost" } } }, gw: NEXT_GW }))).json();
    const tc = await (await POST(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: [], chip: "3xc" } } }, gw: NEXT_GW }))).json();
    expect(bb.proposed.expectedPoints).toBeGreaterThan(none.proposed.expectedPoints + 3);
    expect(tc.proposed.expectedPoints).toBeGreaterThan(none.proposed.expectedPoints + 3);
    const two = await (await POST(post({ season: { ...season, plans: { [NEXT_GW]: { transfers: [], chip: "3xc" } }, actual: { ...squad, chipsUsed: [{ name: "bboost", event: NEXT_GW }] } }, gw: NEXT_GW }))).json();
    expect(two.plan.valid).toBe(false);
  });
});

describe("FPL team import (public endpoints only)", () => {
  const initial = squad.holdings.map((h) => h.id);
  const [a, c, e] = [initial[1], initial[4], initial[7]];
  const repl = (id: number, offset = 0) => ds.players.find((p) => p.pos === by.get(id)!.pos && !initial.includes(p.id) && p.status === "a" && p.teamId !== by.get(id)!.teamId && !initial.some((i) => by.get(i)!.teamId === p.teamId && false))!.id + offset;
  const b = repl(a);
  const d = ds.players.find((p) => p.pos === by.get(c)!.pos && p.id !== b && !initial.includes(p.id) && p.status === "a" && p.teamId !== by.get(c)!.teamId)!.id;
  const f = ds.players.find((p) => p.pos === by.get(e)!.pos && ![b, d].includes(p.id) && !initial.includes(p.id) && p.status === "a")!.id;
  const price = (id: number) => by.get(id)!.costTenths;

  function mockFpl(opts: { private?: boolean } = {}) {
    const picksAt = (ids: number[]) => ({ picks: ids.map((id, i) => ({ element: id, position: i + 1, is_captain: i === 0, is_vice_captain: i === 1 })) });
    const current = initial.map((id) => (id === a ? b : id));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
      if (/entry\/777\/$/.test(u)) return json({ id: 777, name: "Test FC", player_first_name: "Pat", player_last_name: "Lee", started_event: 1, current_event: 10, summary_overall_rank: 12345 });
      if (/entry\/404\/$/.test(u)) return json({}, 404);
      if (opts.private && /history/.test(u)) return json({}, 404);
      if (/entry\/777\/history\/$/.test(u)) {
        return json({
          current: Array.from({ length: 10 }, (_, i) => ({ event: i + 1, points: 50, total_points: 50 * (i + 1), bank: 12, value: 1000, event_transfers: [5, 9].includes(i + 1) ? 1 : 0, event_transfers_cost: 0 })),
          chips: [{ name: "freehit", event: 9 }],
        });
      }
      if (/entry\/777\/transfers\/$/.test(u)) {
        return json([
          { element_in: d, element_in_cost: price(d), element_out: c, element_out_cost: price(c) - 3, event: 11, time: "2026-11-12T10:00:00Z" },
          { element_in: f, element_in_cost: 99, element_out: e, element_out_cost: price(e), event: 9, time: "2026-10-30T10:00:00Z" },
          { element_in: b, element_in_cost: price(b), element_out: a, element_out_cost: price(a), event: 5, time: "2026-09-20T10:00:00Z" },
        ]);
      }
      if (/event\/1\/picks/.test(u)) return json(picksAt(initial));
      if (/event\/10\/picks/.test(u)) return json(picksAt(current));
      return json({}, 404);
    }));
  }

  it("rebuilds squad, purchase prices, bank, free transfers and chips", async () => {
    mockFpl();
    const { GET } = await import("@/app/api/import/[teamId]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ teamId: "777" }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    const st = body.state;
    expect(st.teamName).toBe("Test FC");
    expect(st.actual.gw).toBe(11);
    // a->b (GW5) kept, FH-week transfer (e->f) ignored, pending c->d (GW11) applied
    const ids = st.actual.holdings.map((h: any) => h.id);
    expect(ids).toHaveLength(15);
    expect(ids).toContain(b);
    expect(ids).toContain(d);
    expect(ids).toContain(e);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(c);
    expect(ids).not.toContain(f);
    expect(st.actual.holdings.find((h: any) => h.id === b).buyTenths).toBe(price(b));
    // opening-squad purchase price comes from the GW1 price in element-summary
    expect(st.actual.holdings.find((h: any) => h.id === initial[0]).buyTenths).toBe(price(initial[0]) - 2);
    // bank: last row 12 + pending sale (price-3) - purchase
    expect(st.actual.bankTenths).toBe(12 + (price(c) - 3) - price(d));
    expect(st.actual.chipsUsed).toEqual([{ name: "freehit", event: 9 }]);
    expect(st.actual.captain).toBe(initial[0]);
    // FT derived: 1,2,3,4 -> GW5 used 1 -> 4 -> 5 ... GW9 FH keeps -> cap 5, minus 1 queued
    expect(st.actual.freeTransfers).toBe(4);
    expect(st.actualHistory).toHaveLength(10);
    expect(body.derived.join(" ")).toMatch(/derived/i);
    expect(body.available.freeTransfers).toBe("derived");
  });

  it("returns a clear error for unknown or private teams and bad ids", async () => {
    mockFpl();
    const { GET } = await import("@/app/api/import/[teamId]/route");
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ teamId: "404" }) })).status).toBe(404);
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ teamId: "abc" }) })).status).toBe(400);
  });

  it("never asks for credentials", async () => {
    mockFpl();
    const spy = globalThis.fetch as any;
    const { GET } = await import("@/app/api/import/[teamId]/route");
    await GET(new Request("http://x"), { params: Promise.resolve({ teamId: "777" }) });
    for (const call of spy.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/fantasy\.premierleague\.com\/api\/entry\/777\//);
      expect(JSON.stringify(call[1] ?? {})).not.toMatch(/password|cookie|authorization/i);
    }
  });
});
