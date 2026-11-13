import { NextResponse } from "next/server";
import { getDataset } from "@/lib/fpl/client";
import { fail } from "@/lib/api";
import { freshness, getRepository, invalidateCache, refreshNews } from "@/lib/news/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST /api/news/refresh: manual refresh. Bypasses the freshness window but NOT the 30 s rate limit. */
export async function POST() {
  try {
    if (process.env.NEWS_DISABLED === "1") return NextResponse.json({ refreshed: false, reason: "disabled" }, { status: 200 });
    const ds = await getDataset();
    const r = await refreshNews({ ds, repo: getRepository(), force: true });
    invalidateCache();
    return NextResponse.json({ refreshed: r.refreshed, reason: r.reason, added: r.added, failed: r.failed, freshness: freshness(r.state, ds) }, { status: r.reason === "rate-limited" ? 429 : 200 });
  } catch (e) {
    return fail(e);
  }
}
