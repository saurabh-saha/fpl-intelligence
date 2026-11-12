import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, freshness, parseGw, squadView } from "@/lib/api";
import { horizon } from "@/lib/seasonApi";
import { buildBalancedPlusDoc } from "@/lib/strategies/report";
import { loadValidationSummary } from "@/lib/strategies/validation";

export const dynamic = "force-dynamic";

/**
 * GET /api/strategies/balanced-plus?gw=11
 * The fourth strategy's squad plus a comparison against Balanced, Safe and Aggressive, all computed from the same
 * data snapshot and £100m budget. Every changed player has an explanation.
 */
export async function GET(req: Request) {
  try {
    const ds = await getDataset();
    const gw = parseGw(new URL(req.url).searchParams.get("gw"), ds);
    const hz = horizon(ds, gw);
    const doc = await buildBalancedPlusDoc(ds, gw, hz);
    const { bp } = doc;
    return NextResponse.json({
      gw,
      strategy: doc.definition,
      squad: squadView(ds, hz.display, { starting: bp.starting, bench: bp.bench, squad: bp.squad, formation: bp.formation, captain: bp.captain, viceCaptain: bp.viceCaptain, totalCostTenths: bp.totalCostTenths, remainingTenths: bp.remainingTenths, expectedPoints: bp.expectedPoints }),
      captaincy: { ranking: bp.captaincy.ranking, viceRule: bp.captaincy.viceRule },
      comparison: doc.comparison,
      /** per-player objective value next to the displayed xPts (they are different quantities) */
      objective: (doc.report.strategy as { playerObjective: unknown }).playerObjective,
      validation: loadValidationSummary(),
      ...freshness(ds),
    });
  } catch (e) {
    return fail(e);
  }
}
