import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/api";
import { seasonContext } from "@/lib/seasonApi";
import { planWildcard } from "@/lib/season/chips";
import { chipErrors } from "@/lib/season/rules";

export const dynamic = "force-dynamic";

/** POST /api/season/wildcard  { season, gw? }: best PERMANENT rebuild over the next 5 gameweeks as a transfer list. */
export async function POST(req: Request) {
  try {
    const ctx = await seasonContext(await readJson(req));
    const errors = chipErrors(ctx.ds, ctx.base.chipsUsed, ctx.gw, "wildcard");
    if (errors.length) return NextResponse.json({ error: errors.join(" ") }, { status: 422 });
    return NextResponse.json({ gw: ctx.gw, ...planWildcard(ctx.ds, ctx.base, ctx.gw, ctx.hz) });
  } catch (e) {
    return fail(e);
  }
}
