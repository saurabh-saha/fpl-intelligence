"use client";
import type { FeedEvent } from "@/lib/news/feed";

const CAT: Record<string, string> = { injury: "Injury", illness: "Illness", suspension: "Suspension", international_duty: "International duty", international_fatigue: "International fatigue", late_return: "Late return", rotation: "Rotation", training_update: "Training", manager_update: "Manager", confirmed_team_news: "Team news", other: "Other" };
const STATUS_STYLE: Record<string, string> = { confirmed: "bg-emerald-100 text-emerald-800", reported: "bg-amber-100 text-amber-900", speculative: "bg-slate-200 text-slate-700" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** One deduplicated news event: what was reported, how sure we are, what it does to the projection, and where to check it. */
export function NewsEventCard({ e, compact }: { e: FeedEvent; compact?: boolean }) {
  const i = e.impact;
  return (
    <li className="rounded-xl border border-fpl-purple/10 bg-white p-3 text-sm" data-testid="news-event" data-player={e.playerId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-extrabold text-fpl-purple">{e.playerName}</span>
        <span className="text-xs text-slate-500">{e.clubShort} · {e.pos}</span>
        <span className="rounded-full bg-fpl-bg px-2 py-0.5 text-[11px] font-bold text-fpl-purple">{CAT[e.category] ?? e.category}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLE[e.status]}`}>{e.status}</span>
        <span className="text-[11px] text-slate-500" title="Combined belief across distinct sources">{Math.round(e.belief * 100)}% confidence · {e.independentSources} source{e.independentSources === 1 ? "" : "s"}</span>
        {e.contradicted && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">sources disagree</span>}
      </div>
      <p className="mt-1 text-slate-700">{e.summary}</p>
      {e.expectedReturnDate && <p className="text-xs text-slate-500">Expected back: {e.expectedReturnDate}</p>}
      {i ? (
        <div className="mt-2 grid gap-1 rounded-lg bg-fpl-bg p-2 text-xs sm:grid-cols-4" data-testid="news-impact">
          <div><span className="text-slate-500">xPts GW{i.gw}</span><br /><b>{i.baseXpts.toFixed(1)} → {i.newsAdjustedXpts.toFixed(1)}</b></div>
          <div><span className="text-slate-500">Start prob.</span><br /><b>{Math.round(i.baseStartProbability * 100)}% → {Math.round(i.adjustedStartProbability * 100)}%</b></div>
          <div><span className="text-slate-500">Exp. minutes</span><br /><b>{i.baseExpectedMinutes} → {i.adjustedExpectedMinutes}</b></div>
          <div><span className="text-slate-500">Status</span><br /><b>{i.availabilityStatus.replace("-", " ")}</b></div>
          {!compact && <p className="col-span-full text-slate-600">{i.adjustmentReasons[0]}</p>}
        </div>
      ) : (
        <p className="mt-1 text-xs text-slate-500">No change to projections: {e.fplNews ? "FPL's own status already reflects this." : "this does not alter availability for the selected gameweek."}</p>
      )}
      {!compact && e.upcoming.length > 0 && <p className="mt-1 text-xs text-slate-500">Fixtures: {e.upcoming.map((f) => `GW${f.gw} ${f.opp} ${f.home ? "(H)" : "(A)"}`).join(" · ")}</p>}
      <p className="mt-1 text-[11px] text-slate-500">
        {e.sources.slice(0, compact ? 2 : 5).map((s, k) => (
          <span key={s.url + k}>{k > 0 && " · "}<a href={s.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-fpl-purple underline">{s.name}</a> {when(s.publishedAt)}</span>
        ))}
      </p>
    </li>
  );
}
