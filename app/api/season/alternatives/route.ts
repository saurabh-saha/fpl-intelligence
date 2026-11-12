import { NextResponse } from "next/server";
import { fail, HttpError, readJson } from "@/lib/api";
import { playersFor, seasonContext } from "@/lib/seasonApi";
import { seasonAlternatives } from "@/lib/season/alternatives";

export const dynamic = "force-dynamic";

/**
 * POST /api/season/alternatives  { season, gw?, playerId }
 * Legal replacements for a player in the PROPOSED squad, using real selling prices and the bank,
 * with the change in expected points and any extra -4 hit the swap would trigger.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ctx = await seasonContext(body);
    if (!Number.isInteger(body.playerId)) throw new HttpError(400, "playerId is required.");
    let alts;
    try {
      alts = seasonAlternatives(ctx.ds, ctx.base, ctx.state.plans[ctx.gw], ctx.gw, body.playerId, ctx.hz);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    const players = playersFor(ctx, [body.playerId, ...alts.map((a) => a.playerId)]);
    return NextResponse.json({ gw: ctx.gw, playerId: body.playerId, alternatives: alts.map((a) => ({ ...a, player: players[a.playerId] })) });
  } catch (e) {
    return fail(e);
  }
}
