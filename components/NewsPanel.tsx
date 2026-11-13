"use client";
import { useEffect, useState } from "react";
import type { FeedEvent } from "@/lib/news/feed";
import { NewsEventCard } from "./NewsEventCard";

interface Resp { freshness: { label: "live" | "stale" | "never"; lastSuccessAt: string | null; minutesSinceSuccess: number | null }; events: FeedEvent[]; disabled?: boolean }

/** Compact "news affecting this squad" panel for Team Builder and My Team. */
export function NewsPanel({ ids, gw }: { ids: number[]; gw: number }) {
  const [r, setR] = useState<Resp | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    let cancelled = false;
    fetch(`/api/news?gw=${gw}&ids=${key}&refresh=1`).then((x) => x.json()).then((j) => !cancelled && j.events && setR(j)).catch(() => null);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gw]);
  if (!r || r.disabled) return null;
  const changing = r.events.filter((e) => e.impact);
  const shown = r.events.filter((e) => e.impact || e.category === "injury" || e.category === "suspension").slice(0, 8);
  return (
    <section className="card p-4" data-testid="news-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-extrabold text-fpl-purple">News affecting this squad <span className="text-xs font-semibold text-slate-500">GW{gw}</span></h3>
        <span className="text-[11px] text-slate-500" data-testid="news-freshness">
          {r.freshness.label === "live" ? "Updated" : r.freshness.label === "stale" ? "Stale: last updated" : "Not refreshed yet"} {r.freshness.minutesSinceSuccess !== null ? `${r.freshness.minutesSinceSuccess} min ago` : ""} · <a className="underline" href="/news">News Intelligence</a>
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No injury, suspension or availability news for these players. Projections are unchanged.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-slate-500">{changing.length} player{changing.length === 1 ? "" : "s"} with news-adjusted projections (availability and minutes only; the xPts formula is unchanged).</p>
          <ul className="mt-2 space-y-2">{shown.map((e) => <NewsEventCard key={e.id} e={e} compact />)}</ul>
        </>
      )}
    </section>
  );
}
