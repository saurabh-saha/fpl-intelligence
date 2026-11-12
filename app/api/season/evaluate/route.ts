import { NextResponse } from "next/server";
import { fail, freshness, readJson } from "@/lib/api";
import { evaluateSeason, seasonContext } from "@/lib/seasonApi";

export const dynamic = "force-dynamic";

/**
 * POST /api/season/evaluate  { season, gw? }
 * Rolls the actual squad forward to `gw`, applies that gameweek's plan with the deterministic rules engine
 * (selling prices, bank, free transfers, club limit, chips) and returns BASE vs PROPOSED squads.
 * The actual squad in the request is never modified.
 */
export async function POST(req: Request) {
  try {
    const ctx = await seasonContext(await readJson(req));
    return NextResponse.json({ ...evaluateSeason(ctx), ...freshness(ctx.ds) });
  } catch (e) {
    return fail(e);
  }
}
