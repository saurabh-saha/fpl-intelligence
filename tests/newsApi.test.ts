import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryNewsRepository } from "@/lib/news/repository";
import { setRepository } from "@/lib/news/service";
import { emptyNewsState, type NewsItem } from "@/lib/news/types";
import { NEXT_GW } from "./helpers";
import { by, ds } from "./seasonHelpers";

vi.mock("@/lib/fpl/client", () => ({ getDataset: async () => (await import("./helpers")).sampleDataset(), getElementSummary: async () => null }));

const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const out = (id: number): NewsItem => ({
  id: "n1", playerId: id, playerName: by.get(id)!.webName, club: "", category: "injury", severity: "major", impact: "out", headline: "ruled out", summary: "Ruled out for months.",
  sourceId: "fpl-official", sourceName: "Official FPL status", sourceUrl: "https://fantasy.premierleague.com/statistics", publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
  retrievedAt: new Date().toISOString(), expectedReturnDate: null, status: "confirmed", confidence: 0.95, affectedGameweeks: [], evidence: "x", articleKey: "a",
});
afterEach(() => setRepository(undefined));

describe("News API and strategy integration", () => {
  let optimize: typeof import("@/app/api/optimize/route");
  let news: typeof import("@/app/api/news/route");
  beforeAll(async () => { optimize = await import("@/app/api/optimize/route"); news = await import("@/app/api/news/route"); });

  it("with an empty news store, /api/optimize is identical to before and carries no news fields", async () => {
    setRepository(new MemoryNewsRepository());
    const j = await (await optimize.POST(post({ gw: NEXT_GW, mode: "balanced" }))).json();
    expect(j.starting).toHaveLength(11);
    expect(JSON.stringify(j)).not.toContain("newsImpact\":{");
    const j2 = await (await optimize.POST(post({ gw: NEXT_GW, mode: "balanced", news: false }))).json();
    expect(j2.squadIds).toEqual(j.squadIds);
  });
  it("seeded news removes a ruled-out player and annotates the projection; news:false restores the original", async () => {
    setRepository(new MemoryNewsRepository());
    const base = await (await optimize.POST(post({ gw: NEXT_GW, mode: "balanced" }))).json();
    const victim = base.starting[0].id as number;
    setRepository(new MemoryNewsRepository({ ...emptyNewsState(), items: [out(victim)], lastSuccessAt: new Date().toISOString() }));
    const withNews = await (await optimize.POST(post({ gw: NEXT_GW, mode: "balanced" }))).json();
    expect([...withNews.starting, ...withNews.bench].some((p: { id: number }) => p.id === victim)).toBe(false);
    const off = await (await optimize.POST(post({ gw: NEXT_GW, mode: "balanced", news: false }))).json();
    expect(off.squadIds).toEqual(base.squadIds);
  });
  it("GET /api/news returns events with source links and honest freshness; ids filter works", async () => {
    const id = ds.players.find((p) => p.status === "a" && p.minutes > 600)!.id;
    setRepository(new MemoryNewsRepository({ ...emptyNewsState(), items: [out(id)], lastSuccessAt: new Date().toISOString() }));
    const j = await (await news.GET(new Request(`http://x/api/news?gw=${NEXT_GW}`))).json();
    expect(j.counts.events).toBe(1);
    expect(j.events[0].sources[0].url).toMatch(/^https:/);
    expect(j.events[0].impact.newsAdjustedXpts).toBeLessThan(j.events[0].impact.baseXpts);
    expect(j.freshness.label).toBe("live");
    const none = await (await news.GET(new Request(`http://x/api/news?gw=${NEXT_GW}&ids=-5`))).json();
    expect(none.events).toHaveLength(0);
    setRepository(new MemoryNewsRepository());
    const empty = await (await news.GET(new Request(`http://x/api/news?gw=${NEXT_GW}`))).json();
    expect(empty.freshness.label).toBe("never");
  });
  it("season-long and season transfers routes consume news too", async () => {
    const sl = await import("@/app/api/strategies/season-long/route");
    setRepository(new MemoryNewsRepository());
    const base = await (await sl.POST(post({ gw: NEXT_GW }))).json();
    const victim = base.starting[0].id as number;
    setRepository(new MemoryNewsRepository({ ...emptyNewsState(), items: [out(victim)], lastSuccessAt: new Date().toISOString() }));
    const after = await (await sl.POST(post({ gw: NEXT_GW }))).json();
    expect(after.squadIds).not.toContain(victim);
  });
});
