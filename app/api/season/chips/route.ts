import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/api";
import { seasonContext } from "@/lib/seasonApi";
import { chipStrategy } from "@/lib/season/chips";
import { analyseTransfers } from "@/lib/season/transfers";

export const dynamic = "force-dynamic";

/** POST /api/season/chips  { season, gw? }: use-or-save advice for every chip still available. */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ctx = await seasonContext(body);
    if (ctx.rollErrors.length) return NextResponse.json({ error: ctx.rollErrors.join(" ") }, { status: 422 });
    const t = analyseTransfers(ctx.ds, ctx.base, ctx.gw, ctx.hz);
    const bestNet = Math.max(0, ...t.options.map((o) => o.net));
    return NextResponse.json({ gw: ctx.gw, bestNormalNet: bestNet, advice: chipStrategy(ctx.ds, ctx.base, ctx.gw, bestNet, ctx.hz) });
  } catch (e) {
    return fail(e);
  }
}
