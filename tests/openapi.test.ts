import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const spec = parse(readFileSync(path.join(__dirname, "..", "docs", "openapi.yaml"), "utf8"));

describe("OpenAPI spec", () => {
  it("is OpenAPI 3 and documents every route handler", () => {
    expect(spec.openapi).toMatch(/^3\./);
    const map: Record<string, string> = {
      "/api/bootstrap": "app/api/bootstrap/route.ts",
      "/api/fixtures": "app/api/fixtures/route.ts",
      "/api/gameweek/{id}": "app/api/gameweek/[id]/route.ts",
      "/api/players": "app/api/players/route.ts",
      "/api/player/{id}": "app/api/player/[id]/route.ts",
      "/api/optimize": "app/api/optimize/route.ts",
      "/api/evaluate": "app/api/evaluate/route.ts",
      "/api/alternatives": "app/api/alternatives/route.ts",
      "/api/share-image": "app/api/share-image/route.tsx",
      "/api/openapi": "app/api/openapi/route.ts",
      "/api/backtest": "app/api/backtest/route.ts",
      "/api/report": "app/api/report/route.ts",
      "/api/strategies/balanced-plus": "app/api/strategies/balanced-plus/route.ts",
      "/api/strategies/balanced-plus/report": "app/api/strategies/balanced-plus/report/route.ts",
      "/api/news": "app/api/news/route.ts",
      "/api/news/refresh": "app/api/news/refresh/route.ts",
      "/api/strategies/season-long": "app/api/strategies/season-long/route.ts",
      "/api/strategies/season-long/players": "app/api/strategies/season-long/players/route.ts",
      "/api/strategies/season-long/transfers": "app/api/strategies/season-long/transfers/route.ts",
      "/api/import/{teamId}": "app/api/import/[teamId]/route.ts",
      "/api/season/evaluate": "app/api/season/evaluate/route.ts",
      "/api/season/transfers": "app/api/season/transfers/route.ts",
      "/api/season/chips": "app/api/season/chips/route.ts",
      "/api/season/alternatives": "app/api/season/alternatives/route.ts",
      "/api/season/freehit": "app/api/season/freehit/route.ts",
      "/api/season/wildcard": "app/api/season/wildcard/route.ts",
      "/api/season/commit": "app/api/season/commit/route.ts",
    };
    for (const [url, file] of Object.entries(map)) {
      expect(spec.paths[url], `spec missing ${url}`).toBeDefined();
      expect(existsSync(path.join(__dirname, "..", file)), file).toBe(true);
    }
    expect(Object.keys(spec.paths).sort()).toEqual(Object.keys(map).sort());
  });
  it("references only defined schemas", () => {
    const text = readFileSync(path.join(__dirname, "..", "docs", "openapi.yaml"), "utf8");
    const refs = [...text.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    for (const r of refs) expect(spec.components.schemas[r], r).toBeDefined();
  });
});
