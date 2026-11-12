import { NextResponse } from "next/server";
import { context, fail, HttpError, parseIds, readJson, squadView, view } from "@/lib/api";
import { findAlternatives } from "@/lib/optimizer/alternatives";

export const dynamic = "force-dynamic";

/**
 * POST /api/alternatives
 * Body: { gw?, squad: number[15], playerId, ...prefs }
 * Only returns replacements that keep the squad legal (budget, club limit, position).
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const { ds, gw, prefs, proj } = await context(body.gw, body);
    const ids = parseIds(body.squad);
    if (!Number.isInteger(body.playerId)) throw new HttpError(400, "playerId is required.");
    let out;
    try {
      out = findAlternatives(ds, proj, ids, body.playerId, prefs);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    const byId = new Map(ds.players.map((p) => [p.id, p]));
    return NextResponse.json({
      gw,
      playerId: body.playerId,
      current: squadView(ds, proj, out.current),
      alternatives: out.alternatives.map((a) => ({ ...a, player: view(byId.get(a.playerId)!, proj.get(a.playerId)!, ds) })),
    });
  } catch (e) {
    return fail(e);
  }
}
