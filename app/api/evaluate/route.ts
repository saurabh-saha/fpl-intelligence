import { NextResponse } from "next/server";
import { context, fail, freshness, HttpError, parseIds, readJson, squadView } from "@/lib/api";
import { evaluateSquad } from "@/lib/optimizer/alternatives";
import { validateSquad } from "@/lib/optimizer/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluate
 * Body: { gw?, squad: number[15], ...prefs }
 * Validates a user-edited squad against FPL rules and recalculates XI, captain and expected points.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const { ds, gw, prefs, proj } = await context(body.gw, body);
    const ids = parseIds(body.squad);
    const byId = new Map(ds.players.map((p) => [p.id, p]));
    const v = validateSquad(ids, byId, ds.rules, prefs.budgetTenths);
    if (!v.valid) throw new HttpError(422, v.errors.join(" "));
    return NextResponse.json({ gw, ...squadView(ds, proj, evaluateSquad(ds, proj, ids, prefs)), ...freshness(ds) });
  } catch (e) {
    return fail(e);
  }
}
