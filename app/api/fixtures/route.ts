import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, freshness, parseGw } from "@/lib/api";

export const dynamic = "force-dynamic";

/** GET /api/fixtures?event=11 — fixtures with team names and FDR for one gameweek. */
export async function GET(req: Request) {
  try {
    const ds = await getDataset();
    const gw = parseGw(new URL(req.url).searchParams.get("event"), ds);
    const fixtures = ds.fixtures
      .filter((f) => f.event === gw)
      .map((f) => ({
        id: f.id,
        kickoff: f.kickoff,
        home: { id: f.teamH, short: ds.teams[f.teamH]?.short, name: ds.teams[f.teamH]?.name, difficulty: f.diffH },
        away: { id: f.teamA, short: ds.teams[f.teamA]?.short, name: ds.teams[f.teamA]?.name, difficulty: f.diffA },
        finished: f.finished,
        score: f.finished ? { home: f.scoreH, away: f.scoreA } : null,
      }))
      .sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
    return NextResponse.json({ gw, fixtures, ...freshness(ds) });
  } catch (e) {
    return fail(e);
  }
}
