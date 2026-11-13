import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/api";
import { seasonLongTransfers } from "@/lib/strategies/seasonLong";
import { getSeasonHorizon, parseHorizonEnd } from "@/lib/strategies/seasonLongServer";
import { playersFor, seasonContext } from "@/lib/seasonApi";

export const dynamic = "force-dynamic";

/**
 * POST /api/strategies/season-long/transfers
 * Body: { season: { actual, plans }, gw?, horizonEnd? }  (same season state as /api/season/transfers)
 * Weekly workflow with REST-OF-SEASON value: weakest players, best replacements, use / roll / hit decision. Free transfers, hits (-4),
 * selling prices, bank and club limits come from the existing rules engine; gains are shown both discounted and undiscounted.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ctx = await seasonContext(body);
    if (ctx.rollErrors.length) return NextResponse.json({ error: ctx.rollErrors.join(" ") }, { status: 422 });
    const hz = getSeasonHorizon(ctx.ds, ctx.gw, parseHorizonEnd(body.horizonEnd, ctx.ds, ctx.gw), ctx.news);
    const analysis = seasonLongTransfers(ctx.ds, ctx.base, ctx.gw, hz);
    const ids = new Set<number>();
    analysis.options.forEach((o) => o.transfers.forEach((t) => (ids.add(t.out), ids.add(t.in))));
    analysis.sellCandidates.forEach((s) => (ids.add(s.out), s.alternatives.forEach((a) => ids.add(a.in))));
    return NextResponse.json({ ...analysis, players: playersFor(ctx, ids) });
  } catch (e) {
    return fail(e);
  }
}
