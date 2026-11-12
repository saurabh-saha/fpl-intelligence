import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeDataset } from "@/lib/fpl/normalizer";
import type { Dataset } from "@/lib/fpl/types";

const dir = path.join(__dirname, "fixtures");
export const rawBootstrap = () => JSON.parse(readFileSync(path.join(dir, "bootstrap-static.json"), "utf8"));
export const rawFixtures = () => JSON.parse(readFileSync(path.join(dir, "fixtures.json"), "utf8"));

let cached: Dataset | null = null;
/** Real FPL snapshot (bootstrap-static + fixtures) captured for deterministic tests. */
export function sampleDataset(): Dataset {
  return (cached ??= normalizeDataset(rawBootstrap(), rawFixtures(), { fetchedAt: "2026-11-12T00:00:00.000Z", source: "sample", stale: false }));
}

export const NEXT_GW = 11;
