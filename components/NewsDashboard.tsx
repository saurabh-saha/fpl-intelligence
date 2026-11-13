"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSeason } from "@/lib/season/store";
import type { FeedEvent } from "@/lib/news/feed";
import type { NewsItem } from "@/lib/news/types";
import { NewsEventCard } from "./NewsEventCard";

interface Feed {
  gw: number;
  freshness: { sources: Record<string, { ok: boolean; at: string; error?: string; count?: number }>; label: "live" | "stale" | "never"; lastSuccessAt: string | null; lastAttemptAt: string | null; ttlMinutes: number; minutesSinceSuccess: number | null; hoursToDeadline: number | null };
  sources: { id: string; name: string; kind: string; reliability: number; note: string; status: { ok: boolean; at: string; error?: string; count?: number } | null }[];
  counts: { events: number; changingProjections: number; review: number };
  events: FeedEvent[];
  review: NewsItem[];
  disabled?: boolean;
  refreshNote?: string;
}

const TABS = [
  { id: "all", label: "Latest" },
  { id: "mine", label: "My squad" },
  { id: "changed", label: "Availability changed" },
  { id: "injury", label: "Injuries" },
  { id: "suspension", label: "Suspended" },
  { id: "intl", label: "International / late returns" },
  { id: "rotation", label: "Rotation" },
] as const;

export function NewsDashboard() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [mine, setMine] = useState<Set<number>>(new Set());

  const load = useCallback(async (refresh: boolean) => {
    const r = await fetch(`/api/news?refresh=${refresh ? 1 : 0}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    setFeed(j);
    if (j.refreshNote) setMsg(j.refreshNote);
  }, []);

  useEffect(() => {
    setMine(new Set(loadSeason()?.actual.holdings.map((h) => h.id) ?? []));
    load(true).catch((e) => setMsg(e.message));
  }, [load]);

  async function manual() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/news/refresh", { method: "POST" });
      const j = await r.json();
      setMsg(r.status === 429 ? "Please wait 30 seconds between refreshes." : j.failed?.length ? `Refreshed; sources failed: ${j.failed.join(", ")}` : j.refreshed ? "Refreshed." : j.reason ?? "Nothing refreshed.");
      await load(false);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  const events = useMemo(() => {
    if (!feed) return [];
    const f: Record<string, (e: FeedEvent) => boolean> = {
      all: () => true,
      mine: (e) => mine.has(e.playerId),
      changed: (e) => !!e.impact,
      injury: (e) => e.category === "injury" || e.category === "illness",
      suspension: (e) => e.category === "suspension",
      intl: (e) => ["international_duty", "international_fatigue", "late_return"].includes(e.category),
      rotation: (e) => e.category === "rotation",
    };
    return feed.events.filter(f[tab]);
  }, [feed, tab, mine]);

  if (!feed) return <div className="p-10 text-center text-slate-500">Loading news…</div>;
  const fr = feed.freshness;
  const badge = fr.label === "live" ? "bg-emerald-100 text-emerald-800" : fr.label === "stale" ? "bg-amber-100 text-amber-900" : "bg-slate-200 text-slate-700";
  return (
    <div className="space-y-4" data-testid="news-dashboard">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h1 className="text-xl font-extrabold text-fpl-purple">News Intelligence</h1>
          <p className="text-xs text-slate-500">Injuries, suspensions, international duty, late returns and rotation, de-duplicated across sources. News changes availability and minutes only; the expected-points formula is untouched.</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-1 font-bold ${badge}`} data-testid="news-fresh-badge">{fr.label === "live" ? "Up to date" : fr.label === "stale" ? "Stale" : "Not refreshed yet"}</span>
          <span className="text-slate-500" data-testid="news-last">{fr.lastSuccessAt ? `Last successful refresh ${new Date(fr.lastSuccessAt).toLocaleString()} (${fr.minutesSinceSuccess} min ago)` : "No successful refresh yet"}{fr.hoursToDeadline !== null && fr.hoursToDeadline > 0 ? ` · deadline in ${fr.hoursToDeadline} h, refresh window ${fr.ttlMinutes} min` : ""}</span>
          <button onClick={manual} disabled={busy || feed.disabled} className="rounded-full bg-fpl-purple px-3 py-1.5 font-bold text-white disabled:opacity-40" data-testid="news-refresh">{busy ? "Refreshing…" : "Refresh now"}</button>
        </div>
      </div>
      {feed.disabled && <p className="rounded-xl bg-slate-100 p-3 text-sm">News Intelligence is disabled on this deployment (NEWS_DISABLED=1).</p>}
      {msg && <p className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900" data-testid="news-msg">{msg}</p>}
      <div className="card p-3 text-xs text-slate-600" data-testid="news-sources">
        <b className="text-fpl-purple">Sources:</b>{" "}
        {feed.sources.map((s) => (
          <span key={s.id} className="mr-3">{s.name} ({Math.round(s.reliability * 100)}% reliability) {s.status ? (s.status.ok ? `✓ ${s.status.count ?? 0} items` : `✗ ${s.status.error ?? "failed"}`) : "· not fetched yet"}</span>
        ))}
        {feed.freshness.sources.extractor && <span className="block pt-1" data-testid="news-extractor">Extraction: {feed.freshness.sources.extractor.error ?? "LLM extraction active"}</span>}
        <span className="block pt-1 text-slate-500">Not available: club sites and press-conference transcripts (no permitted public feed) and international squad announcements. Where a source is missing, no news is invented.</span>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} data-testid={`news-tab-${t.id}`} className={`rounded-full border px-3 py-1.5 text-sm font-bold ${tab === t.id ? "border-fpl-purple bg-fpl-purple text-white" : "border-fpl-purple/20 bg-white text-fpl-purple"}`}>{t.label}{t.id === "changed" ? ` (${feed.counts.changingProjections})` : ""}</button>
        ))}
      </div>
      {events.length === 0 ? (
        <p className="card p-4 text-sm text-slate-600" data-testid="news-empty">{tab === "mine" && mine.size === 0 ? "Set up your squad in My Team to see news for your players." : "Nothing in this view."}</p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2" data-testid="news-list">{events.slice(0, 80).map((e) => <NewsEventCard key={e.id} e={e} />)}</ul>
      )}
      {feed.review.length > 0 && (
        <details className="card p-4 text-sm" data-testid="news-review">
          <summary className="cursor-pointer font-bold text-fpl-purple">{feed.review.length} item(s) need review (player identity unclear)</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {feed.review.map((i) => <li key={i.id}>“{i.playerName}”: {i.reviewReason} · <a className="underline" href={i.sourceUrl} target="_blank" rel="noopener noreferrer">{i.sourceName}</a></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
