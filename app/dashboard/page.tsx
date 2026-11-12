"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, deleteSaved, loadSaved, type Meta, type PlayerView, type SavedSquad } from "@/lib/client";
import { encodeShare } from "@/lib/share";
import { GameweekSelector } from "@/components/GameweekSelector";
import { Countdown } from "@/components/Countdown";

interface Accuracy {
  gameweeks: number[];
  model: { mae: number; rmse: number };
  baseline: { mae: number; rmse: number };
  captain: { modelAvgPoints: number; baselineAvgPoints: number; hitRate: number };
  squad: { modelAvg: number; baselineAvg: number };
  generatedAt: string;
}

export default function Dashboard() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gw, setGw] = useState<number>(0);
  const [saved, setSaved] = useState<SavedSquad[]>([]);
  const [acc, setAcc] = useState<Accuracy | null>(null);
  const [cmp, setCmp] = useState<string[]>([]);
  const [players, setPlayers] = useState<Record<number, PlayerView>>({});

  useEffect(() => {
    api<Meta>("/api/bootstrap").then((m) => { setMeta(m); setGw(m.nextGw); });
    setSaved(loadSaved());
    fetch("/api/backtest").then((r) => (r.ok ? r.json() : null)).then(setAcc).catch(() => null);
  }, []);

  const picked = saved.filter((s) => cmp.includes(s.id));
  useEffect(() => {
    if (picked.length === 2) {
      const ids = [...new Set(picked.flatMap((s) => s.ids))];
      api<{ players: PlayerView[] }>(`/api/players?ids=${ids.join(",")}&gw=${picked[0].gw}&limit=100`).then((r) => setPlayers(Object.fromEntries(r.players.map((p) => [p.id, p]))));
    }
  }, [cmp.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = meta?.events.find((e) => e.isNext);
  const current = meta?.events.find((e) => e.isCurrent);

  return (
    <div className="space-y-4">
      <div className="card bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-6 text-white">
        <h1 className="text-3xl font-black">Dashboard</h1>
        {meta && next ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div><div className="text-xs font-bold uppercase text-fpl-green">Current</div><div className="text-2xl font-extrabold">{current?.name ?? "—"}</div></div>
            <div><div className="text-xs font-bold uppercase text-fpl-green">Next deadline · {next.name}</div><div className="text-2xl font-extrabold"><Countdown to={next.deadline} /></div></div>
            <div><div className="text-xs font-bold uppercase text-fpl-green">Data</div><div className="text-sm">{meta.stale ? "⚠ older data, API unreachable" : "Fresh"} · refreshed {meta.source === "sample" ? "(bundled sample)" : new Date(meta.fetchedAt).toLocaleTimeString()}</div></div>
          </div>
        ) : <p className="mt-2 text-white/70">Loading…</p>}
      </div>

      {meta && (
        <div className="card space-y-3 p-4">
          <h2 className="font-extrabold text-fpl-purple">Generate a team</h2>
          <GameweekSelector meta={meta} value={gw} onChange={setGw} />
          <Link href={`/team-builder?gw=${gw}`} className="inline-block rounded-xl bg-fpl-purple px-5 py-2.5 text-sm font-extrabold text-white hover:bg-fpl-purple-2" data-testid="generate">Generate GW{gw} team →</Link>
        </div>
      )}

      {acc && (
        <div className="card p-4" data-testid="accuracy">
          <h2 className="font-extrabold text-fpl-purple">Model accuracy (backtest, GW{acc.gameweeks[0]}–{acc.gameweeks[acc.gameweeks.length - 1]})</h2>
          <p className="text-xs text-slate-500">Predictions rebuilt from data available before each deadline, then compared with actual FPL points.</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            {[["Model MAE", acc.model.mae.toFixed(2)], ["Baseline MAE (PPG)", acc.baseline.mae.toFixed(2)], ["Captain avg pts (model)", acc.captain.modelAvgPoints.toFixed(1)], ["Captain avg pts (PPG)", acc.captain.baselineAvgPoints.toFixed(1)]].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-fpl-bg p-3"><div className="text-[11px] font-semibold text-slate-500">{l}</div><div className="text-2xl font-black text-fpl-purple">{v}</div></div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-4">
        <h2 className="font-extrabold text-fpl-purple">Saved teams</h2>
        {saved.length === 0 && <p className="mt-2 text-sm text-slate-500">Nothing saved yet. Generate a team and hit Save to keep versions and compare them.</p>}
        <ul className="mt-2 divide-y">
          {saved.map((s) => {
            const d = encodeShare({ gw: s.gw, ids: s.ids, captain: s.captain, vice: s.vice, name: s.name, mode: s.mode });
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm" data-testid="saved-row">
                <input type="checkbox" checked={cmp.includes(s.id)} onChange={(e) => setCmp((c) => (e.target.checked ? [...c, s.id].slice(-2) : c.filter((x) => x !== s.id)))} aria-label="Compare" className="h-4 w-4 accent-fpl-purple" />
                <div className="min-w-0 flex-1"><div className="truncate font-bold">{s.name}</div><div className="text-xs text-slate-500">GW{s.gw} · {s.mode} · {s.ep.toFixed(1)} pts · {new Date(s.createdAt).toLocaleDateString()}</div></div>
                <Link href={`/share?d=${d}`} className="font-bold text-fpl-purple underline">Open</Link>
                <button onClick={() => { deleteSaved(s.id); setSaved(loadSaved()); setCmp((c) => c.filter((x) => x !== s.id)); }} className="text-rose-600">Delete</button>
              </li>
            );
          })}
        </ul>
        {picked.length === 2 && (
          <div className="mt-3 rounded-xl bg-fpl-bg p-3 text-sm" data-testid="compare">
            <div className="font-extrabold text-fpl-purple">Comparison</div>
            <div className="mt-1">{picked[0].name}: <b>{picked[0].ep.toFixed(1)}</b> vs {picked[1].name}: <b>{picked[1].ep.toFixed(1)}</b> ({(picked[0].ep - picked[1].ep >= 0 ? "+" : "") + (picked[0].ep - picked[1].ep).toFixed(1)})</div>
            {(() => {
              const a = new Set(picked[0].ids), b = new Set(picked[1].ids);
              const onlyA = picked[0].ids.filter((i) => !b.has(i)), onlyB = picked[1].ids.filter((i) => !a.has(i));
              const nm = (i: number) => players[i]?.name ?? `#${i}`;
              return (<div className="mt-1 grid gap-2 sm:grid-cols-2"><div><b>Only in first:</b> {onlyA.map(nm).join(", ") || "—"}</div><div><b>Only in second:</b> {onlyB.map(nm).join(", ") || "—"}</div><div className="sm:col-span-2"><b>Shared:</b> {a.size - onlyA.length} players</div></div>);
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
