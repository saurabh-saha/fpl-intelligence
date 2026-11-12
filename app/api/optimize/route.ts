import { NextResponse } from "next/server";
import { context, fail, freshness, readJson, squadView } from "@/lib/api";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";

export const dynamic = "force-dynamic";

/**
 * POST /api/optimize
 * Body: { gw?, mode?, budget?, formation?, differential?, maxOwnership?, favourFixtureRuns? }
 * Returns the optimal 15-man squad, XI, formation, bench, captain and vice-captain.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const { ds, gw, prefs, proj } = await context(body.gw, body);
    const t0 = Date.now();
    const out = optimizeSquad(ds, proj, prefs);
    return NextResponse.json({
      gw,
      prefs,
      method: out.method,
      solveMs: Date.now() - t0,
      ...squadView(ds, proj, out.result),
      ...freshness(ds),
    });
  } catch (e) {
    return fail(e);
  }
}
