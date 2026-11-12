import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, freshness, parseGw } from "@/lib/api";

export const dynamic = "force-dynamic";

/** GET /api/gameweek/11 — gameweek info, deadline and fixtures with difficulty ratings. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ds = await getDataset();
    const { id } = await params;
    const gw = parseGw(id, ds);
    const info = ds.events.find((e) => e.id === gw)!;
    const fixtures = ds.fixtures
      .filter((f) => f.event === gw)
      .map((f) => ({
        id: f.id,
        kickoff: f.kickoff,
        home: { id: f.teamH, short: ds.teams[f.teamH]?.short, difficulty: f.diffH },
        away: { id: f.teamA, short: ds.teams[f.teamA]?.short, difficulty: f.diffA },
      }));
    const teamsPlaying = new Set(fixtures.flatMap((f) => [f.home.id, f.away.id]));
    return NextResponse.json({
      ...info,
      fixtures,
      blankTeams: Object.values(ds.teams).filter((t) => !teamsPlaying.has(t.id)).map((t) => t.short),
      ...freshness(ds),
    });
  } catch (e) {
    return fail(e);
  }
}
