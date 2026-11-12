"use client";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, fmtGbp, signed, type PlayerView } from "@/lib/client";
import { Photo } from "@/components/Photo";
import { Fixtures } from "@/components/FixtureDifficulty";
import type { FixtureInfo } from "@/lib/fpl/types";

interface Profile {
  gw: number;
  player: PlayerView;
  recent: { round: number; points: number; minutes: number; goals: number; assists: number; xGI: number; opponent: string; home: boolean }[];
  consistency: { games: number; returnRate: number; haulShare: number; minutesStability: number; label: string };
  upcoming: { gw: number; ep: number; fixtures: FixtureInfo[] }[];
  historyAvailable: boolean;
}

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const gw = useSearchParams().get("gw");
  const [d, setD] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Profile>(`/api/player/${id}${gw ? `?gw=${gw}` : ""}`).then(setD).catch((e) => setErr(e.message)); }, [id, gw]);
  if (err) return <div className="card p-6 text-rose-700">{err}</div>;
  if (!d) return <div className="p-10 text-center text-slate-500">Loading…</div>;
  const p = d.player;
  const maxPts = Math.max(10, ...d.recent.map((r) => r.points));
  const maxEp = Math.max(6, ...d.upcoming.map((u) => u.ep));
  return (
    <div className="space-y-4" data-testid="player-detail">
      <Link href="/players" className="text-sm font-bold text-fpl-purple underline">← All players</Link>
      <div className="card flex flex-wrap items-center gap-4 bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-5 text-white">
        <Photo src={p.photoUrl} name={p.name} pos={p.pos} size={96} />
        <div className="flex-1">
          <h1 className="text-3xl font-black">{p.fullName}</h1>
          <p className="text-white/80">{p.teamName} · {p.pos} · {fmtGbp(p.cost)} · {p.ownership}% owned</p>
          {p.news && <p className="mt-1 inline-block rounded bg-amber-300 px-2 py-0.5 text-sm font-bold text-amber-950">{p.news}</p>}
        </div>
        <div className="text-right"><div className="text-xs font-bold uppercase text-fpl-green">GW{d.gw} xPts</div><div className="text-5xl font-black">{p.ep.toFixed(1)}</div><div className="text-xs text-white/70">{p.confidence} confidence</div></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-2 font-extrabold text-fpl-purple">Season statistics</h2>
          <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-4">
            {[["Points", p.totalPoints], ["PPG", p.ppg], ["Form", p.form], ["Minutes", p.minutes], ["Goals", p.goals], ["Assists", p.assists], ["xG", p.xG], ["xA", p.xA], ["xGI", p.xGI], ["Bonus", p.bonus], ["Clean sheets", p.cleanSheets], ["Saves", p.saves]].map(([l, v]) => (
              <div key={String(l)} className="rounded-xl bg-fpl-bg p-2"><div className="text-[11px] font-semibold text-slate-500">{l}</div><div className="font-extrabold text-fpl-purple">{v}</div></div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="mb-2 font-extrabold text-fpl-purple">Recent performance</h2>
          {d.recent.length === 0 ? <p className="text-sm text-slate-500">Gameweek history unavailable right now.</p> : (
            <>
              <div className="flex h-32 items-end gap-2" data-testid="recent-chart">
                {d.recent.map((r) => (
                  <div key={r.round} className="flex flex-1 flex-col items-center gap-1" title={`GW${r.round}: ${r.points} pts, ${r.minutes}′ vs ${r.opponent}`}>
                    <span className="text-[11px] font-bold">{r.points}</span>
                    <div className={`w-full rounded-t ${r.points >= 8 ? "bg-fpl-pink" : r.points >= 4 ? "bg-fpl-purple" : "bg-slate-300"}`} style={{ height: `${Math.max(4, (r.points / maxPts) * 90)}px` }} />
                    <span className="text-[10px] text-slate-500">{r.round}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Consistency: <b className="capitalize">{d.consistency.label}</b>
                {d.consistency.label !== "n/a" && ` — returns in ${Math.round(d.consistency.returnRate * 100)}% of games, best match is ${Math.round(d.consistency.haulShare * 100)}% of recent points.`}
              </p>
            </>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-2 font-extrabold text-fpl-purple">Upcoming fixtures & projection</h2>
          <ul className="space-y-1.5">
            {d.upcoming.map((u) => (
              <li key={u.gw} className="flex items-center gap-3 text-sm">
                <span className="w-12 font-bold text-slate-500">GW{u.gw}</span>
                <span className="w-28"><Fixtures fixtures={u.fixtures} /></span>
                <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100"><span className="block h-full bg-fpl-purple" style={{ width: `${(u.ep / maxEp) * 100}%` }} /></span>
                <span className="w-10 text-right font-bold tabular-nums">{u.ep.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card p-4">
          <h2 className="mb-2 font-extrabold text-fpl-purple">Recommendation explanation</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {p.warnings.length > 0 && <ul className="mt-3 space-y-1 text-sm">{p.warnings.map((w, i) => <li key={i} className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-900">⚠ {w}</li>)}</ul>}
          <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-slate-500">xPts breakdown</h3>
          <div className="grid grid-cols-2 gap-x-4 text-sm">{Object.entries(p.components).filter(([, v]) => Math.abs(v) >= 0.01).map(([k, v]) => <div key={k} className="flex justify-between"><span className="capitalize text-slate-600">{k.replace(/([A-Z])/g, " $1")}</span><span className="tabular-nums">{signed(v, 2)}</span></div>)}</div>
        </div>
      </div>
    </div>
  );
}
