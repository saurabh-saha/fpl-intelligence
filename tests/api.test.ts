import { beforeAll, describe, expect, it, vi } from "vitest";
import { sampleDataset, NEXT_GW } from "./helpers";

vi.mock("@/lib/fpl/client", () => ({
  getDataset: async () => (await import("./helpers")).sampleDataset(),
  getElementSummary: async () => ({
    history: [
      { round: 8, total_points: 2, minutes: 90, goals_scored: 0, assists: 0, expected_goal_involvements: "0.1", opponent_team: 1, was_home: true },
      { round: 9, total_points: 9, minutes: 90, goals_scored: 1, assists: 0, expected_goal_involvements: "0.6", opponent_team: 2, was_home: false },
      { round: 10, total_points: 6, minutes: 80, goals_scored: 0, assists: 1, expected_goal_involvements: "0.3", opponent_team: 3, was_home: true },
    ],
  }),
}));

const post = (body: unknown) =>
  new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (qs = "") => new Request(`http://x/api?${qs}`);

let squad: number[];
let optimizeRoute: typeof import("@/app/api/optimize/route");

beforeAll(async () => {
  optimizeRoute = await import("@/app/api/optimize/route");
  const res = await optimizeRoute.POST(post({ gw: NEXT_GW }));
  squad = (await res.json()).squadIds;
});

describe("API routes", () => {
  it("GET /api/bootstrap returns season metadata with freshness", async () => {
    const { GET } = await import("@/app/api/bootstrap/route");
    const body = await (await GET()).json();
    expect(body.nextGw).toBe(11);
    expect(body.currentGw).toBe(10);
    expect(body.events).toHaveLength(38);
    expect(body.teams).toHaveLength(20);
    expect(body.fetchedAt).toBeTruthy();
    expect(body.rules.teamLimit).toBe(3);
  });

  it("GET /api/gameweek/:id works and validates", async () => {
    const { GET } = await import("@/app/api/gameweek/[id]/route");
    const ok = await GET(get(), { params: Promise.resolve({ id: "11" }) });
    const body = await ok.json();
    expect(body.id).toBe(11);
    expect(body.fixtures.length).toBeGreaterThan(0);
    const bad = await GET(get(), { params: Promise.resolve({ id: "99" }) });
    expect(bad.status).toBe(400);
  });

  it("GET /api/fixtures returns team names and FDR", async () => {
    const { GET } = await import("@/app/api/fixtures/route");
    const body = await (await GET(get("event=11"))).json();
    expect(body.gw).toBe(11);
    expect(body.fixtures[0].home.short).toBeTruthy();
    expect(body.fixtures[0].home.difficulty).toBeGreaterThanOrEqual(1);
    expect((await GET(get("event=abc"))).status).toBe(400);
  });

  it("POST /api/optimize returns a valid squad and metadata", async () => {
    const res = await optimizeRoute.POST(post({ gw: NEXT_GW, mode: "safe", formation: "4-4-2" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.squadIds).toHaveLength(15);
    expect(body.starting).toHaveLength(11);
    expect(body.bench).toHaveLength(4);
    expect(body.formation).toBe("4-4-2");
    expect(body.totalCost + body.remaining).toBeCloseTo(100, 5);
    expect(body.starting[0].reasons.length).toBeGreaterThan(0);
    expect(body.method).toBe("ilp");
  });

  it("POST /api/optimize validates input", async () => {
    expect((await optimizeRoute.POST(post({ budget: 5 }))).status).toBe(400);
    expect((await optimizeRoute.POST(post({ formation: "abc" }))).status).toBe(400);
    expect((await optimizeRoute.POST(post({ gw: 77 }))).status).toBe(400);
    expect((await optimizeRoute.POST(post({ differential: 3 }))).status).toBe(400);
    expect((await optimizeRoute.POST(new Request("http://x", { method: "POST", body: "{nope" }))).status).toBe(400);
  });

  it("POST /api/optimize returns 422 when constraints are infeasible", async () => {
    const res = await optimizeRoute.POST(post({ budget: 40 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/No valid squad/);
  });

  it("POST /api/alternatives lists legal replacements with deltas", async () => {
    const { POST } = await import("@/app/api/alternatives/route");
    const res = await POST(post({ gw: NEXT_GW, squad, playerId: squad[2] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alternatives.length).toBeGreaterThan(5);
    const a = body.alternatives[0];
    expect(a.player.name).toBeTruthy();
    expect(typeof a.deltaEp).toBe("number");
    expect(a.remainingTenths).toBeGreaterThanOrEqual(0);
    expect((await POST(post({ squad, playerId: 1 }))).status).toBe(422);
    expect((await POST(post({ squad }))).status).toBe(400);
  });

  it("POST /api/evaluate recalculates a swapped squad and rejects illegal ones", async () => {
    const alt = await (await import("@/app/api/alternatives/route")).POST(post({ gw: NEXT_GW, squad, playerId: squad[2] }));
    const first = (await alt.json()).alternatives[0];
    const next = squad.map((id: number) => (id === squad[2] ? first.playerId : id));
    const { POST } = await import("@/app/api/evaluate/route");
    const ok = await POST(post({ gw: NEXT_GW, squad: next }));
    expect(ok.status).toBe(200);
    expect([...(await ok.json()).squadIds].sort()).toEqual([...next].sort());
    const bad = await POST(post({ gw: NEXT_GW, squad: squad.slice(0, 14) }));
    expect(bad.status).toBe(422);
  });

  it("GET /api/players filters, searches and sorts", async () => {
    const { GET } = await import("@/app/api/players/route");
    const body = await (await GET(get("gw=11&pos=FWD&sort=goals&limit=5"))).json();
    expect(body.players).toHaveLength(5);
    expect(body.players.every((p: any) => p.pos === "FWD")).toBe(true);
    expect(body.players[0].goals).toBeGreaterThanOrEqual(body.players[4].goals);
    const s = await (await GET(get("q=haaland"))).json();
    expect(s.players[0].name).toBe("Haaland");
    const cost = await (await GET(get("sort=cost&dir=asc&limit=1"))).json();
    expect(cost.players[0].cost).toBeLessThanOrEqual(4.1);
  });

  it("GET /api/player/:id returns profile, history, consistency and upcoming fixtures", async () => {
    const { GET } = await import("@/app/api/player/[id]/route");
    const id = sampleDataset().players.find((p) => p.webName === "Haaland")!.id;
    const body = await (await GET(get("gw=11"), { params: Promise.resolve({ id: String(id) }) })).json();
    expect(body.player.name).toBe("Haaland");
    expect(body.recent).toHaveLength(3);
    expect(body.consistency.label).toBeDefined();
    expect(body.upcoming).toHaveLength(6);
    expect((await GET(get(), { params: Promise.resolve({ id: "999999" }) })).status).toBe(404);
  });

  it("GET /api/openapi serves the spec", async () => {
    const { GET } = await import("@/app/api/openapi/route");
    expect(await (await GET()).text()).toContain("openapi: 3");
  });
});
