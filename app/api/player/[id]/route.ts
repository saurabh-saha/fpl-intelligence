import { NextResponse } from "next/server";
import { context, fail, HttpError, view } from "@/lib/api";
import { getElementSummary } from "@/lib/fpl/client";
import { consistencyOf } from "@/lib/analytics/consistency";
import { fixturesForTeam } from "@/lib/analytics/fixtureAnalysis";
import { projectPlayer } from "@/lib/analytics/expectedPoints";

export const dynamic = "force-dynamic";

/** GET /api/player/{id}?gw= — full profile: projection, explanation, recent history, consistency, next fixtures. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const sp = new URL(req.url).searchParams;
    const { ds, gw, proj, ctx } = await context(sp.get("gw"));
    const { id } = await params;
    const p = ds.players.find((x) => x.id === Number(id));
    if (!p) throw new HttpError(404, `Player ${id} not found.`);
    const summary = await getElementSummary(p.id);
    const history = (summary?.history ?? []) as any[];
    const lastGw = ds.events[ds.events.length - 1]?.id ?? gw;
    const upcoming = [];
    for (let g = gw; g <= Math.min(gw + 5, lastGw); g++) {
      const pr = projectPlayer(p, ctx, g);
      upcoming.push({ gw: g, ep: pr.ep, fixtures: fixturesForTeam(ds.fixtures, ds.teams, p.teamId, g) });
    }
    return NextResponse.json({
      gw,
      player: view(p, proj.get(p.id)!, ds),
      recent: history.slice(-8).map((h) => ({
        round: h.round,
        points: h.total_points,
        minutes: h.minutes,
        goals: h.goals_scored,
        assists: h.assists,
        xGI: Number(h.expected_goal_involvements ?? 0),
        opponent: ds.teams[h.opponent_team]?.short,
        home: h.was_home,
      })),
      consistency: consistencyOf(history),
      upcoming,
      historyAvailable: history.length > 0,
    });
  } catch (e) {
    return fail(e);
  }
}
