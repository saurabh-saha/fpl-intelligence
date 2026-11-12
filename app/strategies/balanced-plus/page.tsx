"use client";
import { useEffect, useState } from "react";
import { api, fmtGbp, type Meta, type SquadView } from "@/lib/client";
import { FootballPitch } from "@/components/FootballPitch";
import { GameweekSelector } from "@/components/GameweekSelector";

interface Metric { key: string; label: string; formation: string; costM: number; bankM: number; gw0Xpts: number; fiveGwXpts: number; fiveGwDiscounted: number; maxClubInXI: number; clubsOverTwoInXI: string[]; benchXpts: number; xiAvgStartProb: number; xiXgi90Outfield: number; xiFormTiltXpts: number; captain: { name: string; xpts: number }; vice: { name: string; sameClubAsCaptain: boolean } }
interface Swap { position: string; out: { name: string; club: string; role: string }; in: { name: string; club: string; role: string }; whyOut: string[]; whyIn: string[]; explanation: string }
interface Change { against: string; againstLabel: string; overlap: number; swaps: Swap[]; roleChanges: { explanation: string }[]; captaincy: { explanation: string } }
interface Obj { name: string; displayedXptsGw: number; objectiveValueGw: number; displayedXpts5Gw: number; objectiveValue5Gw: number; formXptsRemoved5Gw: number; xgxaRebuild5Gw: number }
interface Resp { gw: number; objective: Obj[]; validation: { available: boolean; verdictText?: string; lines?: string[]; limitations?: string[] }; strategy: { name: string; summary: string; rules: string[]; methodology: { objectiveVersusDisplayedXpts: string; realisedDataInObjective: string; form: string } }; squad: SquadView; comparison: { metrics: Metric[]; changes: Change[]; notes: string[] }; fetchedAt: string }

export default function BalancedPlusPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gw, setGw] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Meta>("/api/bootstrap").then((m) => { setMeta(m); setGw(m.nextGw); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    if (!gw) return;
    setData(null);
    api<Resp>(`/api/strategies/balanced-plus?gw=${gw}`).then(setData).catch((e) => setErr(e.message));
  }, [gw]);
  const row = (label: string, f: (m: Metric) => string) => (
    <tr className="border-t"><td className="py-1.5 pr-3 font-semibold text-slate-600">{label}</td>{data!.comparison.metrics.map((m) => <td key={m.key} className={`px-2 py-1.5 tabular-nums ${m.key === "balanced-plus" ? "bg-fpl-green/15 font-bold" : ""}`}>{f(m)}</td>)}</tr>
  );
  return (
    <div className="space-y-4" data-testid="bp-page">
      <div className="card bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-5 text-white">
        <h1 className="text-3xl font-black">Balanced Plus <span className="text-base font-bold text-fpl-green">fourth strategy</span></h1>
        <p className="mt-1 text-sm text-white/85">{data?.strategy.summary ?? "A diversified, minutes-secure squad judged over five gameweeks."}</p>
      </div>
      {meta && <GameweekSelector meta={meta} value={gw} onChange={setGw} />}
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700" role="alert">{err}</div>}
      {!data && !err && <div className="p-10 text-center text-slate-500"><span className="spinner" /> Optimising…</div>}
      {data && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <FootballPitch squad={data.squad} />
              <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="bp-xpts-note">The xPts on the pitch are the <b>displayed</b> projection shared by all four strategies. They are <b>not</b> the Balanced Plus objective that chose these players (see the table below).</p>
            </div>
            <div className="space-y-4">
              <div className="card p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">GW{data.gw} projected points</div>
                <div className="text-5xl font-black text-fpl-purple" data-testid="bp-ep">{data.squad.expectedPoints.toFixed(1)}</div>
                <p className="text-sm text-slate-600">{data.squad.formation} · {fmtGbp(data.squad.totalCost)} · bank {fmtGbp(data.squad.remaining)}</p>
                <a href={`/api/strategies/balanced-plus/report?gw=${data.gw}`} download data-testid="download-bp-report" className="mt-3 block rounded-xl border-2 border-fpl-purple py-2 text-center text-sm font-extrabold text-fpl-purple hover:bg-fpl-purple hover:text-white">⬇ Download Balanced Plus GW{data.gw} report (PDF)</a>
              </div>
              <div className="card p-4">
                <h2 className="font-extrabold text-fpl-purple">Rules</h2>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-700">{data.strategy.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            </div>
          </div>
          <div className="card p-4" data-testid="bp-objective">
            <h2 className="font-extrabold text-fpl-purple">Optimiser objective vs displayed xPts</h2>
            <p className="mt-1 text-xs text-slate-700">{data.strategy.methodology.objectiveVersusDisplayedXpts}</p>
            <p className="mt-1 text-xs text-slate-700"><b>Objective uses:</b> {data.strategy.methodology.realisedDataInObjective}</p>
            <p className="mt-1 text-xs text-slate-700"><b>Form:</b> {data.strategy.methodology.form}</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[620px] text-xs">
                <thead><tr className="text-left uppercase text-slate-500"><th>Player</th><th className="text-right">Displayed GW</th><th className="text-right">Objective GW</th><th className="text-right">Displayed 5-GW</th><th className="text-right">Objective 5-GW</th><th className="text-right">Form removed</th><th className="text-right">xG/xA rebuild</th></tr></thead>
                <tbody>{data.objective.map((o) => <tr key={o.name} className="border-t"><td className="py-1 font-semibold">{o.name}</td><td className="text-right tabular-nums">{o.displayedXptsGw.toFixed(2)}</td><td className="text-right tabular-nums">{o.objectiveValueGw.toFixed(2)}</td><td className="text-right tabular-nums">{o.displayedXpts5Gw.toFixed(2)}</td><td className="text-right tabular-nums">{o.objectiveValue5Gw.toFixed(2)}</td><td className="text-right tabular-nums">{o.formXptsRemoved5Gw.toFixed(2)}</td><td className="text-right tabular-nums">{o.xgxaRebuild5Gw.toFixed(2)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
          {data.validation.available && (
            <div className="card p-4" data-testid="bp-validation">
              <h2 className="font-extrabold text-fpl-purple">Historical validation</h2>
              <p className="mt-1 text-sm font-bold">{data.validation.verdictText}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-700">{data.validation.lines?.map((l, i) => <li key={i}>{l}</li>)}</ul>
              <h3 className="mt-2 text-xs font-bold uppercase tracking-wide text-slate-500">Limitations</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-700" data-testid="bp-limitations">{data.validation.limitations?.map((l, i) => <li key={i}>{l}</li>)}</ul>
              <p className="mt-1 text-[11px] text-slate-500">Details: docs/BALANCED_PLUS_BACKTEST.md. The GW comparison below is one snapshot, not evidence of better performance.</p>
            </div>
          )}
          <div className="card overflow-x-auto p-4">
            <h2 className="font-extrabold text-fpl-purple">Comparison with the three existing strategies</h2>
            <table className="mt-2 w-full min-w-[640px] text-sm" data-testid="bp-compare">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th /> {data.comparison.metrics.map((m) => <th key={m.key} className="px-2">{m.label}</th>)}</tr></thead>
              <tbody>
                {row("Formation", (m) => m.formation)}
                {row(`GW${data.gw} xPts`, (m) => m.gw0Xpts.toFixed(2))}
                {row("5-GW xPts", (m) => m.fiveGwXpts.toFixed(2))}
                {row("5-GW discounted", (m) => m.fiveGwDiscounted.toFixed(2))}
                {row("Max from one club in XI", (m) => `${m.maxClubInXI}${m.clubsOverTwoInXI.length ? ` (${m.clubsOverTwoInXI.join(", ")})` : ""}`)}
                {row("XI avg start prob", (m) => `${Math.round(m.xiAvgStartProb * 100)}%`)}
                {row("Bench xPts", (m) => m.benchXpts.toFixed(1))}
                {row("XI xGI/90 (outfield sum)", (m) => m.xiXgi90Outfield.toFixed(2))}
                {row("Displayed form tilt in XI (not in BP objective)", (m) => m.xiFormTiltXpts.toFixed(2))}
                {row("Captain", (m) => `${m.captain.name} (${m.captain.xpts.toFixed(1)})`)}
                {row("Vice-captain", (m) => `${m.vice.name}${m.vice.sameClubAsCaptain ? " (same club)" : ""}`)}
              </tbody>
            </table>
            {data.comparison.notes.map((n, i) => <p key={i} className="mt-1 text-[11px] text-slate-500">{n}</p>)}
          </div>
          {data.comparison.changes.map((c) => (
            <div key={c.against} className="card p-4" data-testid={`bp-changes-${c.against}`}>
              <h3 className="font-extrabold text-fpl-purple">vs {c.againstLabel}: {c.swaps.length} player change(s), {c.roleChanges.length} role change(s), {c.overlap}/15 shared</h3>
              <div className="mt-2 space-y-2">
                {c.swaps.map((s, i) => (
                  <details key={i} className="rounded-xl border p-2" data-testid="bp-swap">
                    <summary className="cursor-pointer text-sm font-bold"><span className="text-rose-700">{s.out.name}</span> ({s.out.club}, {s.out.role}) → <span className="text-emerald-700">{s.in.name}</span> ({s.in.club}, {s.in.role})</summary>
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-700">{s.whyOut.map((w, j) => <li key={`o${j}`}><b>Out:</b> {w}</li>)}{s.whyIn.map((w, j) => <li key={`i${j}`}><b>In:</b> {w}</li>)}</ul>
                  </details>
                ))}
                {c.roleChanges.map((r, i) => <p key={i} className="rounded-lg bg-fpl-bg p-2 text-xs">{r.explanation}</p>)}
                <p className="text-xs text-slate-600">{c.captaincy.explanation}</p>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
