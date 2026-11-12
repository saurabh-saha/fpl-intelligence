import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/api";
import { playersFor, seasonContext } from "@/lib/seasonApi";
import { analyseTransfers } from "@/lib/season/transfers";

export const dynamic = "force-dynamic";

/**
 * POST /api/season/transfers  { season, gw? }
 * Transfer recommendations for the BASE squad of `gw`: options for 0-4 transfers, the save-vs-use decision,
 * and up to five alternatives for every player (the "sell" list).
 */
export async function POST(req: Request) {
  try {
    const ctx = await seasonContext(await readJson(req));
    if (ctx.rollErrors.length) return NextResponse.json({ error: ctx.rollErrors.join(" ") }, { status: 422 });
    const analysis = analyseTransfers(ctx.ds, ctx.base, ctx.gw, ctx.hz);
    const ids = new Set<number>();
    analysis.options.forEach((o) => o.transfers.forEach((t) => (ids.add(t.out), ids.add(t.in))));
    analysis.sellCandidates.forEach((s) => (ids.add(s.out), s.alternatives.forEach((a) => ids.add(a.in))));
    return NextResponse.json({ ...analysis, players: playersFor(ctx, ids) });
  } catch (e) {
    return fail(e);
  }
}
