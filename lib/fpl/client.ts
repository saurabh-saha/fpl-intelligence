import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeDataset } from "./normalizer";
import type { Dataset } from "./types";

const BASE = "https://fantasy.premierleague.com/api";
export const CACHE_TTL_MS = 15 * 60 * 1000;
// Serverless filesystems are read-only except the temp directory; the snapshot is only a best-effort fallback.
const CACHE_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "fpl-intelligence") : path.join(process.cwd(), ".cache");
const SAMPLE_DIR = path.join(process.cwd(), "tests", "fixtures");

interface Entry<T> {
  value: T;
  at: number;
}
interface Store {
  dataset?: Entry<Dataset>;
  inflight?: Promise<Dataset>;
  live: Map<number, Entry<any>>;
  elementSummary: Map<number, Entry<any>>;
}
// Survive Next.js dev hot reloads.
const g = globalThis as unknown as { __fplStore?: Store };
const store: Store = (g.__fplStore ??= { live: new Map(), elementSummary: new Map() });

export function resetCache() {
  store.dataset = undefined;
  store.inflight = undefined;
  store.live.clear();
  store.elementSummary.clear();
}

async function getJson(url: string, timeoutMs = 20000): Promise<any> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; fpl-intelligence/1.0)", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`FPL API ${res.status} for ${url}`);
  const text = await res.text();
  // The API answers 200 with a plain-text "being updated" body during deadline processing.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`FPL API returned non-JSON (likely updating): ${text.slice(0, 80)}`);
  }
}

export const fetchBootstrap = () => getJson(`${BASE}/bootstrap-static/`);
export const fetchFixtures = () => getJson(`${BASE}/fixtures/`);
export const fetchLive = (gw: number) => getJson(`${BASE}/event/${gw}/live/`);
export const fetchElementSummary = (id: number) => getJson(`${BASE}/element-summary/${id}/`);

async function readDisk(): Promise<{ bootstrap: any; fixtures: any; fetchedAt: string } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, "snapshot.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeDisk(bootstrap: any, fixtures: any, fetchedAt: string) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, "snapshot.json"), JSON.stringify({ bootstrap, fixtures, fetchedAt }));
  } catch {
    /* read-only filesystems are fine, the in-memory cache still works */
  }
}

async function loadSample(): Promise<Dataset> {
  const bootstrap = JSON.parse(await fs.readFile(path.join(SAMPLE_DIR, "bootstrap-static.json"), "utf8"));
  const fixtures = JSON.parse(await fs.readFile(path.join(SAMPLE_DIR, "fixtures.json"), "utf8"));
  return normalizeDataset(bootstrap, fixtures, { fetchedAt: "1970-01-01T00:00:00.000Z", source: "sample", stale: true });
}

async function refresh(): Promise<Dataset> {
  try {
    const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const fetchedAt = new Date().toISOString();
    const dataset = normalizeDataset(bootstrap, fixtures, { fetchedAt, source: "live", stale: false });
    store.dataset = { value: dataset, at: Date.now() };
    void writeDisk(bootstrap, fixtures, fetchedAt);
    return dataset;
  } catch (err) {
    // Degrade gracefully: previous in-memory data, then disk snapshot, then bundled sample.
    if (store.dataset) return { ...store.dataset.value, stale: true };
    const disk = await readDisk();
    if (disk) {
      const ds = normalizeDataset(disk.bootstrap, disk.fixtures, { fetchedAt: disk.fetchedAt, source: "cache", stale: true });
      store.dataset = { value: ds, at: Date.now() - CACHE_TTL_MS + 60_000 }; // retry upstream in a minute
      return ds;
    }
    const sample = await loadSample();
    store.dataset = { value: sample, at: Date.now() - CACHE_TTL_MS + 60_000 };
    console.warn("[fpl] upstream unavailable, using bundled sample:", (err as Error).message);
    return sample;
  }
}

/** Dataset with ~15 minute caching and request de-duplication. */
export async function getDataset(force = false): Promise<Dataset> {
  const hit = store.dataset;
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (store.inflight) return store.inflight;
  store.inflight = refresh().finally(() => {
    store.inflight = undefined;
  });
  return store.inflight;
}

export async function getElementSummary(id: number): Promise<any | null> {
  const hit = store.elementSummary.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = await fetchElementSummary(id);
    store.elementSummary.set(id, { value, at: Date.now() });
    return value;
  } catch {
    return hit?.value ?? null;
  }
}

export async function getLive(gw: number): Promise<any | null> {
  const hit = store.live.get(gw);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  try {
    const value = await fetchLive(gw);
    store.live.set(gw, { value, at: Date.now() });
    return value;
  } catch {
    return hit?.value ?? null;
  }
}
