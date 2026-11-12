import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { nextGameweek } from "@/lib/fpl/normalizer";
import { fail, freshness } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Normalised season metadata: gameweeks, teams, rules, scoring and data freshness. */
export async function GET() {
  try {
    const ds = await getDataset();
    const next = nextGameweek(ds.events);
    return NextResponse.json({
      currentGw: ds.events.find((e) => e.isCurrent)?.id ?? null,
      nextGw: next.id,
      events: ds.events,
      teams: Object.values(ds.teams).map((t) => ({ id: t.id, name: t.name, short: t.short, badgeUrl: t.badgeUrl, played: t.played })),
      rules: ds.rules,
      scoring: ds.scoring,
      playerCount: ds.players.length,
      ...freshness(ds),
    });
  } catch (e) {
    return fail(e);
  }
}
