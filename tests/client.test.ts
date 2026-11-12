import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(__dirname, "fixtures");
const boot = readFileSync(path.join(dir, "bootstrap-static.json"), "utf8");
const fix = readFileSync(path.join(dir, "fixtures.json"), "utf8");

async function freshClient() {
  vi.resetModules();
  const m = await import("@/lib/fpl/client");
  m.resetCache();
  return m;
}
afterEach(() => vi.unstubAllGlobals());

describe("FPL client caching and resilience", () => {
  it("caches for 15 minutes and de-duplicates concurrent requests", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(String(url).includes("fixtures") ? fix : boot));
    vi.stubGlobal("fetch", fetchMock);
    const { getDataset } = await freshClient();
    const [a, b] = await Promise.all([getDataset(), getDataset()]);
    expect(a.source).toBe("live");
    expect(b.fetchedAt).toBe(a.fetchedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2); // bootstrap + fixtures, once
    await getDataset();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await getDataset(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("serves stale data when the API later fails", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (fail) throw new Error("network down");
      return new Response(String(url).includes("fixtures") ? fix : boot);
    }));
    const { getDataset } = await freshClient();
    const live = await getDataset();
    fail = true;
    const stale = await getDataset(true);
    expect(stale.stale).toBe(true);
    expect(stale.fetchedAt).toBe(live.fetchedAt);
    expect(stale.players.length).toBe(live.players.length);
  });

  it("treats the plain-text 'being updated' response as a failure and falls back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("The game is being updated.")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getDataset } = await freshClient();
    const ds = await getDataset();
    expect(ds.stale).toBe(true);
    expect(["cache", "sample"]).toContain(ds.source);
    expect(ds.players.length).toBeGreaterThan(300);
    warn.mockRestore();
  });
});
