"use client";
import { useEffect, useMemo, useState } from "react";
import { api, fmtGbp, signed, type PlayerView, type Prefs, type SquadView } from "@/lib/client";
import { Photo } from "./Photo";
import { Fixtures } from "./FixtureDifficulty";

interface Alt {
  playerId: number;
  ep: number;
  deltaEp: number;
  deltaCostTenths: number;
  remainingTenths: number;
  player: PlayerView;
  /** Season Manager extras (absent in the New Squad Builder) */
  sellTenths?: number;
  deltaHorizon?: number;
  extraHit?: number;
  net?: number;
}

interface Props {
  player: PlayerView;
  gw: number;
  squad: SquadView;
  prefs: Prefs;
  onClose: () => void;
  onReplace: (inId: number) => void;
  isCaptain: boolean;
  /** Season Manager: load replacement candidates with real selling prices instead of the builder endpoint */
  loadAlts?: (playerId: number) => Promise<Alt[]>;
  note?: string;
}

const CONF: Record<string, string> = { high: "bg-emerald-100 text-emerald-800", medium: "bg-amber-100 text-amber-800", low: "bg-rose-100 text-rose-800" };

/** Slide-over: why the player was picked, plus every legal replacement. */
export function PlayerPanel({ player: p, gw, squad, prefs, onClose, onReplace, isCaptain, loadAlts, note }: Props) {
  const [tab, setTab] = useState<"why" | "replace">("why");
  const [alts, setAlts] = useState<Alt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<"ep" | "cost" | "delta">("ep");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    setAlts(null);
    setErr(null);
    (loadAlts ? loadAlts(p.id) : api<{ alternatives: Alt[] }>("/api/alternatives", { gw, squad: squad.squadIds, playerId: p.id, mode: prefs.mode, budget: prefs.budget }).then((r) => r.alternatives))
      .then((r) => live && setAlts(r))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, gw, squad.squadIds, prefs.mode, prefs.budget]);

  const shown = useMemo(() => {
    const list = (alts ?? []).filter((a) => !q || a.player.name.toLowerCase().includes(q.toLowerCase()) || a.player.team.toLowerCase().includes(q.toLowerCase()));
    const by = { ep: (a: Alt) => -a.ep, cost: (a: Alt) => a.player.costTenths, delta: (a: Alt) => -a.deltaEp }[sort];
    return [...list].sort((a, b) => by(a) - by(b));
  }, [alts, sort, q]);

  const comps = Object.entries(p.components).filter(([k, v]) => k !== "formAdj" || Math.abs(v) > 0.01).filter(([, v]) => Math.abs(v) >= 0.01);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" data-testid="panel">
      <button className="absolute inset-0 bg-black/40" onClick={onClose} aria-label="Close panel" />
      <aside className="slidein relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <div className="flex items-center gap-3 bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-4 text-white">
          <Photo src={p.photoUrl} name={p.name} pos={p.pos} size={64} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-extrabold">{p.fullName}</div>
            <div className="text-sm text-white/80">{p.teamName} · {p.pos} · {fmtGbp(p.cost)} · {p.ownership}% owned</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-fpl-green px-2 py-0.5 font-extrabold text-fpl-purple">{p.ep.toFixed(1)} xPts</span>
              <span className={`rounded-full px-2 py-0.5 font-bold ${CONF[p.confidence]}`}>{p.confidence} confidence</span>
              {isCaptain && <span className="rounded-full bg-white px-2 py-0.5 font-bold text-fpl-purple">Captain</span>}
            </div>
          </div>
          <button onClick={onClose} className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-bold hover:bg-white/25" data-testid="close-panel">✕</button>
        </div>
        <div className="flex border-b">
          {(["why", "replace"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} data-testid={`tab-${t}`} className={`flex-1 px-4 py-3 text-sm font-bold ${tab === t ? "border-b-4 border-fpl-purple text-fpl-purple" : "text-slate-500"}`}>
              {t === "why" ? "Why selected" : `Replace${alts ? ` (${alts.length})` : ""}`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "why" && (
            <div className="space-y-4" data-testid="why">
              <section>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">GW{gw} fixture</h3>
                <Fixtures fixtures={p.fixtures} />
              </section>
              <section>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Why the model rates this player</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </section>
              {p.warnings.length > 0 && (
                <section>
                  <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-amber-700">Warnings</h3>
                  <ul className="space-y-1 text-sm">
                    {p.warnings.map((w, i) => <li key={i} className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-900">⚠ {w}</li>)}
                  </ul>
                </section>
              )}
              <section>
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Expected points breakdown</h3>
                <div className="space-y-1">
                  {comps.map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 capitalize text-slate-600">{k.replace(/([A-Z])/g, " $1")}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                        <span className={`block h-full ${v < 0 ? "bg-rose-400" : "bg-fpl-purple"}`} style={{ width: `${Math.min(100, (Math.abs(v) / Math.max(p.ep, 1)) * 100)}%` }} />
                      </span>
                      <span className="w-12 text-right tabular-nums">{signed(v, 2)}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="grid grid-cols-3 gap-2 text-center text-sm sm:grid-cols-4">
                {[["Goals", p.goals], ["Assists", p.assists], ["xG", p.xG], ["xA", p.xA], ["Minutes", p.minutes], ["Form", p.form], ["Start prob", `${Math.round(p.startProb * 100)}%`], ["Total pts", p.totalPoints]].map(([l, v]) => (
                  <div key={String(l)} className="rounded-xl bg-fpl-bg p-2"><div className="text-[11px] font-semibold text-slate-500">{l}</div><div className="font-extrabold text-fpl-purple">{v}</div></div>
                ))}
              </section>
              <a href={`/player/${p.id}?gw=${gw}`} className="inline-block text-sm font-bold text-fpl-purple underline">Full player profile →</a>
            </div>
          )}

          {tab === "replace" && (
            <div data-testid="replace">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or club" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" />
                {(["ep", "delta", "cost"] as const).map((s) => (
                  <button key={s} onClick={() => setSort(s)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${sort === s ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple"}`}>
                    {s === "ep" ? "xPts" : s === "delta" ? "Δ squad" : "Price"}
                  </button>
                ))}
              </div>
              <p className="mb-2 text-xs text-slate-500">{note ?? `Only legal swaps are listed: same position, within budget (£${squad.remaining.toFixed(1)}m in the bank), max 3 per club.`}</p>
              {err && <p className="rounded bg-rose-50 p-3 text-sm text-rose-700">{err}</p>}
              {!alts && !err && <p className="p-6 text-center text-sm text-slate-500">Loading alternatives…</p>}
              <ul className="space-y-2">
                {shown.map((a) => {
                  const x = a.player;
                  return (
                    <li key={x.id} className="rounded-xl border p-3 hover:border-fpl-purple/50" data-testid={`alt-${x.id}`}>
                      <div className="flex items-center gap-3">
                        <Photo src={x.photoUrl} name={x.name} pos={x.pos} size={44} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-extrabold text-fpl-purple">{x.name} <span className="text-xs font-semibold text-slate-500">{x.team} · {x.pos}</span></div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-600">
                            <span className="font-bold">{fmtGbp(x.cost)}</span>
                            <span>xPts <b>{x.ep.toFixed(1)}</b></span>
                            <span>{x.goals}G {x.assists}A</span>
                            <span>xG {x.xG} · xA {x.xA}</span>
                            <span>{x.minutes}′</span>
                            <span>Form {x.form}</span>
                            <span>Start {Math.round(x.startProb * 100)}%</span>
                            <span>{x.ownership}% own</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2"><Fixtures fixtures={x.fixtures} /><span className={`rounded px-1.5 text-[10px] font-bold ${CONF[x.confidence]}`}>{x.confidence}</span></div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-black ${a.deltaEp >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{signed(a.deltaEp)} pts</div>
                          <div className="text-[11px] text-slate-500">{a.deltaCostTenths === 0 ? "same price" : `${signed(a.deltaCostTenths / 10)}m`}</div>
                          {a.net !== undefined && <div className={`text-[11px] font-bold ${a.net >= 0 ? "text-emerald-700" : "text-rose-700"}`} title="Weighted 5-GW gain after any extra hit">5-GW net {signed(a.net)}{a.extraHit ? ` (−${a.extraHit} hit)` : ""}</div>}
                          <button onClick={() => onReplace(x.id)} data-testid={`swap-${x.id}`} className="mt-1 rounded-full bg-fpl-purple px-3 py-1 text-xs font-bold text-white hover:bg-fpl-purple-2">Swap in</button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {alts && shown.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No legal alternatives match.</p>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
