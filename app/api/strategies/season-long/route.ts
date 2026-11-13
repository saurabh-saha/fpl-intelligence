import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, freshness, HttpError, parseGw, parsePrefs, readJson, squadView } from "@/lib/api";
import { describeSeasonLong, horizonInfo, optimizeSeasonLong, seasonLongSummary, SeasonLongError } from "@/lib/strategies/seasonLong";
import { loadOverlay } from "@/lib/news/service";
import { getSeasonHorizon, parseHorizonEnd } from "@/lib/strategies/seasonLongServer";

export const dynamic = "force-dynamic";

/**
 * POST /api/strategies/season-long
 * Body: { gw?, horizonEnd?, budget?, formation?, maxOwnership? }
 * A 15-player squad built for the REST of the season (GW..horizonEnd, default GW38): discounted remaining-season xPts,
 * availability and rotation modelling, bench cover, independent captaincy. Same response shape as /api/optimize plus
 * `seasonLong` (horizon, totals, per-player rest-of-season details and reasons). Does not touch the other strategies.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ds = await getDataset();
    const gw = parseGw(body.gw, ds);
    const prefs = parsePrefs(body, ds);
    const hz = getSeasonHorizon(ds, gw, parseHorizonEnd(body.horizonEnd, ds, gw), await loadOverlay({ disabled: body.news === false }));
    let r;
    try {
      r = optimizeSeasonLong(ds, hz, { budgetTenths: prefs.budgetTenths, formation: prefs.formation, maxOwnership: prefs.maxOwnership });
    } catch (e) {
      if (e instanceof SeasonLongError) throw new HttpError(422, e.message);
      throw e;
    }
    const sel = { starting: r.starting, bench: r.bench, captain: r.captain, vice: r.viceCaptain, coreXI: r.coreXI };
    return NextResponse.json({
      gw,
      strategy: "season-long",
      prefs: { budgetTenths: prefs.budgetTenths, formation: prefs.formation, maxOwnership: prefs.maxOwnership },
      ...squadView(ds, hz.display, { starting: r.starting, bench: r.bench, squad: r.squad, formation: r.formation, captain: r.captain, viceCaptain: r.viceCaptain, totalCostTenths: r.totalCostTenths, remainingTenths: r.remainingTenths, expectedPoints: r.expectedPoints }),
      seasonLong: { horizon: horizonInfo(hz), summary: seasonLongSummary(ds, hz, r.values, sel), rows: describeSeasonLong(ds, hz, r.values, sel), constraintsRelaxed: r.relaxed > 0 },
      ...freshness(ds),
    });
  } catch (e) {
    return fail(e);
  }
}
