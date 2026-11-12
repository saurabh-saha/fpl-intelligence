import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Serves the hand-maintained OpenAPI spec (docs/openapi.yaml). */
export async function GET() {
  const yaml = await fs.readFile(path.join(process.cwd(), "docs", "openapi.yaml"), "utf8");
  return new Response(yaml, { headers: { "content-type": "application/yaml; charset=utf-8" } });
}
