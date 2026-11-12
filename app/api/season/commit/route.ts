import { NextResponse } from "next/server";
import { fail, HttpError, readJson } from "@/lib/api";
import { evaluateSeason, seasonContext } from "@/lib/seasonApi";
import { rollForward } from "@/lib/season/squad";
import type { Snapshot } from "@/lib/season/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/season/commit  { season, gw }
 * "Lock in": the deadline has passed, the gameweek's plan becomes reality. Returns the new ACTUAL squad for
 * gw+1 (Free Hit reverted, free transfers rolled) and a snapshot holding the pre-deadline prediction.
 * The client persists it; the server stores nothing.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ctx = await seasonContext(body);
    if (ctx.gw !== ctx.state.actual.gw) throw new HttpError(400, `Only the current gameweek (GW${ctx.state.actual.gw}) can be locked in.`);
    const ev = evaluateSeason(ctx);
    if (!ev.plan.valid) throw new HttpError(422, `Plan is not legal: ${ev.plan.errors.join(" ")}`);
    const { base, errors } = rollForward(ctx.state, ctx.ds, ctx.gw + 1);
    if (errors.length) throw new HttpError(422, errors.join(" "));
    const snapshot: Snapshot = {
      gw: ctx.gw,
      squadIds: [...ev.proposed.starting.map((p) => p.id), ...ev.proposed.bench.map((p) => p.id)],
      captain: ev.proposed.captain,
      vice: ev.proposed.viceCaptain,
      chip: ev.plan.chip,
      transfers: ev.plan.transfers.map((t) => ({ out: t.out, in: t.in, outSellTenths: t.sellTenths, inBuyTenths: t.buyTenths })),
      hitCost: ev.plan.hitCost,
      predictedEp: ev.proposed.expectedPoints,
      lockedAt: new Date().toISOString(),
    };
    return NextResponse.json({ newActual: base, snapshot });
  } catch (e) {
    return fail(e);
  }
}
