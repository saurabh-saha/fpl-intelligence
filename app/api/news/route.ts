import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail, parseGw } from "@/lib/api";
import { buildFeed } from "@/lib/news/feed";
import { getRepository, invalidateCache, loadState, refreshNews } from "@/lib/news/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/news?gw=11&ids=1,2,3&refresh=1
 * Deduplicated news events with source links, freshness and items needing review. `refresh=1` refreshes first when the
 * cache is older than the deadline-aware refresh window (it never bypasses the rate limit). `ids` restricts to players.
 * Vercel has no background jobs here, so refreshing is request-driven (stale-while-revalidate on read).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ds = await getDataset();
    const gw = parseGw(url.searchParams.get("gw"), ds);
    let refreshNote: string | undefined;
    if (url.searchParams.get("refresh") === "1" && process.env.NEWS_DISABLED !== "1") {
      const r = await Promise.race([refreshNews({ ds, repo: getRepository() }), new Promise<null>((res) => setTimeout(() => res(null), 12_000))]);
      invalidateCache();
      refreshNote = r === null ? "refresh still running; showing cached news" : r.refreshed ? undefined : r.reason;
      if (r?.failed.length) refreshNote = `some sources failed: ${r.failed.join(", ")}`;
    }
    const ids = url.searchParams.get("ids");
    const set = ids ? new Set(ids.split(",").map(Number).filter(Number.isFinite)) : undefined;
    const feed = buildFeed(ds, await loadState(0), gw, new Date(), { ids: set });
    return NextResponse.json({ ...feed, disabled: process.env.NEWS_DISABLED === "1", refreshNote });
  } catch (e) {
    return fail(e);
  }
}
