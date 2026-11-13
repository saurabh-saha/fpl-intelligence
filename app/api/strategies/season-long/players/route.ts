import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, HttpError, parseGw, parseIds, readJson } from "@/lib/api";
import { validateLineup, validateSquad } from "@/lib/optimizer/validation";
import { describeSeasonLong, horizonInfo, seasonLongSummary, seasonValues } from "@/lib/strategies/seasonLong";
import { loadOverlay } from "@/lib/news/service";
import { getSeasonHorizon, parseHorizonEnd } from "@/lib/strategies/seasonLongServer";

export const dynamic = "force-dynamic";

/**
 * POST /api/strategies/season-long/players
 * Body: { gw?, horizonEnd?, starting[11], bench[4], captain, vice }
 * Rest-of-season details, totals and reasons for the squad EXACTLY as given (e.g. after the user swapped players). Never regenerates.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const ds = await getDataset();
    const gw = parseGw(body.gw, ds);
    const starting = parseIds(body.starting, "starting");
    const bench = parseIds(body.bench, "bench");
    if (starting.length !== 11 || bench.length !== 4) throw new HttpError(400, "starting must have 11 and bench 4 player ids.");
    const by = new Map(ds.players.map((p) => [p.id, p]));
    const all = [...starting, ...bench];
    const sv = validateSquad(all, by, ds.rules, ds.rules.budgetTenths);
    if (!sv.valid) throw new HttpError(422, `Squad is not legal: ${sv.errors.join(" ")}`);
    const cnt = (pos: string) => starting.filter((id) => by.get(id)!.pos === pos).length;
    const lineup = { starting, bench, formation: `${cnt("DEF")}-${cnt("MID")}-${cnt("FWD")}`, captain: body.captain, viceCaptain: body.vice };
    const lv = validateLineup(lineup, all, by, ds.rules);
    if (!lv.valid) throw new HttpError(422, `Lineup is not legal: ${lv.errors.join(" ")}`);
    const hz = getSeasonHorizon(ds, gw, parseHorizonEnd(body.horizonEnd, ds, gw), await loadOverlay({ disabled: body.news === false }));
    const vals = seasonValues(ds, hz);
    const sel = { starting, bench, captain: body.captain, vice: body.vice };
    return NextResponse.json({ gw, horizon: horizonInfo(hz), summary: seasonLongSummary(ds, hz, vals, sel), rows: describeSeasonLong(ds, hz, vals, sel) });
  } catch (e) {
    return fail(e);
  }
}
