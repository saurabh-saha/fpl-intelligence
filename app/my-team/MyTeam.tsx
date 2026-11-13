"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtGbp, signed, type Meta, type PlayerView } from "@/lib/client";
import type { ChipsResp, EvalResp, TransfersResp } from "@/lib/seasonClient";
import { editPlan } from "@/lib/season/squad";
import { NewsPanel } from "@/components/NewsPanel";
import { clearSeason, loadSeason, saveSeason, withActuals } from "@/lib/season/store";
import { commitLock, history, markResynced, undoableLock, undoLastLock, whyNotUndoable } from "@/lib/season/lockHistory";
import type { GwPlan, RecEntry, SeasonState, Snapshot } from "@/lib/season/types";
import type { ChipName } from "@/lib/fpl/types";
import type { TransferDetail, TransferOption } from "@/lib/season/transfers";
import { FootballPitch } from "@/components/FootballPitch";
import { PlayerPanel } from "@/components/AlternativeSelector";
import { ShareModal } from "@/components/ShareModal";
import { Countdown } from "@/components/Countdown";
import { DownloadReportButton } from "@/components/DownloadReportButton";
import { Photo } from "@/components/Photo";
import { Onboarding } from "@/components/season/Onboarding";
import { SeasonSummary, Tag } from "@/components/season/SeasonSummary";
import { ACTION_STYLE, OptionsTable, TransferCard } from "@/components/season/TransferRecommendations";
import { ChipPanel } from "@/components/season/ChipPanel";
import { HistoryPanel } from "@/components/season/HistoryPanel";
import { TeamSettings } from "@/components/season/TeamSettings";

const emptyPlan = (): GwPlan => ({ transfers: [] });
const tkey = (t: { out: number; in: number }) => `${t.out}>${t.in}`;
const planIsEmpty = (p: GwPlan) => p.transfers.length === 0 && !p.chip && !p.freeHitIds;

export function MyTeam() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [state, setState] = useState<SeasonState | null | undefined>(undefined);
  const [gw, setGw] = useState(0);
  const [ev, setEv] = useState<EvalResp | null>(null);
  const [tr, setTr] = useState<TransfersResp | null>(null);
  const [chips, setChips] = useState<ChipsResp | null>(null);
  const [undo, setUndo] = useState<GwPlan[]>([]);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<PlayerView | null>(null);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // Transfer horizon: the next five gameweeks (default) or the rest of the season (Season Long strategy).
  const [horizon, setHorizon] = useState<"five" | "season">("five");
  const seq = useRef(0);
  const seqAnalysis = useRef(0);

  /* ---------- load + persist ---------- */
  useEffect(() => {
    api<Meta>("/api/bootstrap").then(setMeta).catch((e) => setErr(e.message));
    const s = loadSeason();
    setState(s);
    if (s) setGw(s.actual.gw);
  }, []);
  useEffect(() => {
    if (state) saveSeason(state);
  }, [state]);

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };
  const plan = (state && state.plans[gw]) || emptyPlan();

  const body = useCallback((extra: object = {}) => ({ season: { source: state!.source, actual: state!.actual, plans: state!.plans }, gw, ...extra }), [state, gw]);

  /* ---------- evaluation: BASE vs PROPOSED, always from the deterministic engine ---------- */
  useEffect(() => {
    if (!state || !gw) return;
    const id = ++seq.current;
    api<EvalResp>("/api/season/evaluate", body())
      .then((r) => { if (id === seq.current) { setEv(r); setErr(null); } })
      .catch((e) => id === seq.current && setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.actual, state?.plans, gw]);

  /* ---------- analysis of the BASE squad (does not depend on this gameweek's plan) ---------- */
  const analysisKey = useMemo(() => {
    if (!state) return "";
    const earlier = Object.fromEntries(Object.entries(state.plans).filter(([g]) => Number(g) < gw));
    return JSON.stringify([state.actual, earlier, gw, horizon]);
  }, [state, gw, horizon]);
  useEffect(() => {
    if (!state || !gw) return;
    setTr(null);
    setChips(null);
    setRejected(new Set());
    const id = ++seqAnalysis.current;
    const b = { season: { source: state.source, actual: state.actual, plans: state.plans }, gw };
    api<TransfersResp>(horizon === "season" ? "/api/strategies/season-long/transfers" : "/api/season/transfers", b).then((r) => id === seqAnalysis.current && setTr(r)).catch((e) => setErr(e.message));
    api<ChipsResp>("/api/season/chips", b).then((r) => id === seqAnalysis.current && setChips(r)).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey]);

  /* log each new recommendation once (historical recommendations) */
  useEffect(() => {
    if (!tr || !state) return;
    const best = tr.options[tr.recommendedN];
    const entry: RecEntry = { gw: tr.gw, at: new Date().toISOString(), label: tr.headline, transfers: best.transfers.map((t) => ({ out: t.out, in: t.in, net: t.net })), net: best.net, predictedEp: ev?.base.expectedPoints ?? 0, decision: "pending" };
    const last = state.recs.find((r) => r.gw === tr.gw);
    if (last && last.label === entry.label && JSON.stringify(last.transfers) === JSON.stringify(entry.transfers)) return;
    setState((s) => (s ? { ...s, recs: [entry, ...s.recs].slice(0, 60) } : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr]);

  const markRec = (decision: RecEntry["decision"]) =>
    setState((s) => {
      if (!s) return s;
      const i = s.recs.findIndex((r) => r.gw === gw);
      if (i < 0) return s;
      const recs = [...s.recs];
      recs[i] = { ...recs[i], decision };
      return { ...s, recs };
    });

  /* ---------- plan editing (never touches state.actual) ---------- */
  const setPlan = (next: GwPlan) => {
    setUndo((u) => [...u.slice(-30), plan]);
    setState((s) => {
      if (!s) return s;
      const plans = { ...s.plans };
      if (planIsEmpty(next)) delete plans[gw];
      else plans[gw] = next;
      return { ...s, plans };
    });
  };
  const baseIds = ev?.base.holdings.map((h) => h.id) ?? [];
  const guardFh = () => {
    if (plan.chip === "freehit") { setErr("Cancel the Free Hit first: under a Free Hit you edit the temporary squad directly."); return true; }
    return false;
  };
  const accept = (t: { out: number; in: number }) => {
    if (guardFh()) return;
    try { setPlan(editPlan(plan, baseIds, t.out, t.in)); markRec("accepted"); } catch (e) { setErr((e as Error).message); }
  };
  const unaccept = (t: { out: number; in: number }) => setPlan({ ...plan, transfers: plan.transfers.filter((x) => tkey(x) !== tkey(t)) });
  const applyOption = (o: TransferOption) => {
    if (guardFh()) return;
    setPlan({ ...plan, transfers: o.transfers.map((t) => ({ out: t.out, in: t.in })) });
    markRec(o.n === 0 ? "rejected" : "accepted");
  };

  const play = async (c: ChipName) => {
    if (!state) return;
    setBusy(true);
    try {
      if (c === "wildcard") {
        const r = await api<{ transfers: { out: number; in: number }[] }>("/api/season/wildcard", body());
        setPlan({ chip: "wildcard", transfers: r.transfers });
      } else if (c === "freehit") {
        const r = await api<{ ids: number[] }>("/api/season/freehit", body());
        setPlan({ chip: "freehit", transfers: [], freeHitIds: r.ids });
      } else setPlan({ ...plan, chip: c });
      setErr(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const cancelChip = () => {
    if (plan.chip === "wildcard") setPlan({ transfers: [] });
    else if (plan.chip === "freehit") setPlan({ transfers: [] });
    else setPlan({ ...plan, chip: null });
  };

  const replace = (outId: number, inId: number) => {
    if (plan.chip === "freehit") {
      const ids = (plan.freeHitIds ?? []).map((id) => (id === outId ? inId : id));
      setPlan({ ...plan, freeHitIds: ids });
    } else {
      try { setPlan(editPlan(plan, baseIds, outId, inId)); } catch (e) { setErr((e as Error).message); return; }
    }
    setSelected(null);
    say("Squad updated: recalculated");
  };
  const loadAlts = useCallback(
    async (playerId: number) => {
      const r = await api<{ alternatives: any[] }>("/api/season/alternatives", body({ playerId }));
      return r.alternatives.map((a) => ({ ...a, deltaEp: a.deltaEpGw, deltaCostTenths: a.buyTenths - a.sellTenths, remainingTenths: a.bankAfterTenths }));
    },
    [body],
  );

  const doUndo = () => {
    const prev = undo[undo.length - 1];
    if (!prev) return;
    setUndo((u) => u.slice(0, -1));
    setState((s) => { if (!s) return s; const plans = { ...s.plans }; if (planIsEmpty(prev)) delete plans[gw]; else plans[gw] = prev; return { ...s, plans }; });
  };
  const restore = () => {
    setUndo((u) => [...u.slice(-30), plan]);
    setState((s) => { if (!s) return s; const plans = { ...s.plans }; delete plans[gw]; return { ...s, plans }; });
    setRejected(new Set());
  };

  async function lockIn() {
    if (!state || !ev) return;
    if (!confirm(`Lock in GW${gw} inside FPL Intelligence?\n\n• This records your current proposed plan as your actual squad here and advances to GW${gw + 1}.\n• It does NOT make any transfers on the official FPL website. Make those moves there yourself, before the deadline.\n• If you click this by mistake, use "Undo last Lock in" to reverse it inside FPL Intelligence.`)) return;
    setBusy(true);
    const r = await commitLock(state, gw, () => api<{ newActual: SeasonState["actual"]; snapshot: Snapshot }>("/api/season/commit", body()));
    if (r.error) setErr(r.error);
    else {
      setState(withActuals(r.state));
      setGw(r.state.actual.gw);
      setUndo([]);
      say(`GW${gw} locked in. Now planning GW${r.state.actual.gw}`);
    }
    setBusy(false);
  }

  function undoLock() {
    if (!state) return;
    const rec = undoableLock(state);
    if (!rec) return;
    if (!confirm(`Undo the lock-in of GW${rec.gw}?\n\nThis restores your squad, plans and history in FPL Intelligence to how they were before you locked in GW${rec.gw}, and returns to GW${rec.prev.actual.gw}. It does not change your official FPL team.`)) return;
    const restored = undoLastLock(state);
    if (!restored) return;
    seq.current++; seqAnalysis.current++; // drop any in-flight analysis for the old state
    setState(withActuals(restored));
    setGw(restored.actual.gw);
    setUndo([]);
    setRejected(new Set());
    setEv(null);
    setTr(null);
    setChips(null);
    say(`GW${rec.gw} lock-in undone. Back to planning GW${restored.actual.gw}`);
  }

  async function resync() {
    if (!state?.teamId) return;
    if (!confirm("Re-import your team from FPL? Your actual squad is replaced with the real one and unsaved plans are cleared. History is kept.")) return;
    try {
      const r = await api<{ state: SeasonState }>(`/api/import/${state.teamId}`);
      setState(withActuals({ ...r.state, snapshots: state.snapshots, recs: state.recs, lockHistory: markResynced(state.lockHistory) }));
      setGw(r.state.actual.gw);
      setUndo([]);
      say("Re-synced from FPL");
    } catch (e) { setErr((e as Error).message); }
  }

  /* ---------- onboarding ---------- */
  if (state === undefined) return <div className="p-10 text-center text-slate-500">Loading…</div>;
  if (state === null)
    return <Onboarding nextGw={meta?.nextGw ?? 11} onState={(s, n) => { setState(withActuals(s)); setGw(s.actual.gw); setNotes(n ?? []); }} />;

  const nextGw = meta?.nextGw;
  const info = meta?.events.find((e) => e.id === gw);
  const horizonGws = Array.from({ length: 6 }, (_, i) => state.actual.gw + i).filter((g) => g <= 38);
  const recommended = tr?.options[tr.recommendedN];
  const acceptedKeys = new Set(plan.transfers.map(tkey));
  const stateOf = (t: TransferDetail) => (acceptedKeys.has(tkey(t)) ? "accepted" : rejected.has(tkey(t)) ? "rejected" : "pending");
  const squadForPitch = ev?.proposed;
  const baseSet = new Set(ev?.base.holdings.map((h) => h.id));
  const changed = new Set((squadForPitch ? [...squadForPitch.starting, ...squadForPitch.bench] : []).filter((p) => !baseSet.has(p.id)).map((p) => p.id));
  const canLock = gw === state.actual.gw && ev?.plan.valid;
  const ftDerived = state.source === "import";

  return (
    <div className="space-y-4" data-testid="my-team">
      <div className="card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-fpl-purple">{state.teamName ?? "My team"} <span className="text-base font-bold text-slate-500">Season Manager</span></h1>
          {info && <p className="text-sm text-slate-600" data-testid="mt-deadline">GW{gw} deadline {new Date(info.deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · in <b><Countdown to={info.deadline} /></b></p>}
        </div>
        <p className="text-[11px] text-slate-500"><Tag kind="actual" /> real FPL data · <Tag kind="derived" /> computed from your history · <Tag kind="model" /> model prediction</p>
      </div>

      {(notes.length > 0 || state.warnings.length > 0) && (
        <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900" data-testid="mt-notes">
          {[...notes, ...state.warnings].map((n, i) => <p key={i}>ⓘ {n}</p>)}
        </div>
      )}
      {nextGw && state.actual.gw < nextGw && (
        <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900" data-testid="mt-stale">Your saved squad is for GW{state.actual.gw} but FPL is now on GW{nextGw}. {state.teamId ? "Re-sync from FPL (Team settings) to pick up your latest moves," : "Lock in the weeks you have played"} or keep planning from here.</div>
      )}
      {gw > state.actual.gw && <div className="rounded-xl bg-fpl-purple/5 p-3 text-sm text-fpl-purple" data-testid="mt-ahead">Planning ahead: this squad includes your accepted plans for GW{state.actual.gw}–GW{gw - 1}. Your actual squad is unchanged.</div>}
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700" role="alert" data-testid="mt-error">{err}</div>}
      {ev && ev.rollErrors.length > 0 && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{ev.rollErrors.join(" ")}</div>}

      <div className="scroll-hide flex gap-2 overflow-x-auto py-1" role="tablist" aria-label="Planning gameweek">
        {horizonGws.map((g) => (
          <button key={g} role="tab" aria-selected={g === gw} data-testid={`mt-gw-${g}`} onClick={() => { setGw(g); setUndo([]); }} className={`shrink-0 rounded-full border px-4 py-2 text-sm font-bold ${g === gw ? "border-fpl-purple bg-fpl-purple text-white" : "border-fpl-purple/20 bg-white text-fpl-purple"}`}>
            GW {g}{g === state.actual.gw && <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] ${g === gw ? "bg-fpl-green text-fpl-purple" : "bg-fpl-purple/10"}`}>ACTUAL</span>}{state.plans[g] && g !== gw && <span className="ml-1 text-fpl-pink">●</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          {squadForPitch ? (
            <>
              {plan.chip === "freehit" && <div className="mb-2 rounded-xl bg-fpl-pink px-3 py-2 text-sm font-bold text-white" data-testid="mt-fh-banner">Free Hit squad (temporary): your real squad returns after GW{gw}.</div>}
              <FootballPitch squad={squadForPitch} onSelect={setSelected} changedIds={changed} />
            </>
          ) : <div className="pitch grid min-h-[520px] place-items-center text-white"><span className="spinner" /></div>}
        </div>
        <div className="space-y-4">
          {ev && <SeasonSummary ev={ev} gw={gw} ftDerived={ftDerived} teamName={state.teamName} />}
          {ev && !ev.plan.valid && <div className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700" data-testid="plan-errors">{ev.plan.errors.map((e, i) => <p key={i}>⚠ {e}</p>)}</div>}
          <div className="card space-y-2 p-4">
            <div className="flex flex-wrap gap-2">
              <button onClick={doUndo} disabled={undo.length === 0} title={undo.length === 0 ? "Make a squad edit to enable Undo." : "Undo your last squad edit"} className="rounded-full bg-fpl-bg px-3 py-1.5 text-xs font-bold text-fpl-purple disabled:opacity-40" data-testid="mt-undo">↶ Undo</button>
              <button onClick={restore} disabled={planIsEmpty(plan)} title={planIsEmpty(plan) ? "No proposed changes to restore." : "Discard this gameweek's proposed changes"} className="rounded-full bg-fpl-bg px-3 py-1.5 text-xs font-bold text-fpl-purple disabled:opacity-40" data-testid="mt-restore">Restore original squad</button>
              <button onClick={() => setSharing(true)} disabled={!ev} className="rounded-full bg-fpl-purple px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40" data-testid="mt-share">Share plan</button>
            </div>
            <button onClick={lockIn} disabled={!canLock || busy} className="w-full rounded-xl bg-fpl-green py-2 text-sm font-extrabold text-fpl-purple disabled:opacity-40" data-testid="lock-in" title={gw !== state.actual.gw ? "Only the current gameweek can be locked in" : ""}>Lock in GW{gw} &amp; advance →</button>
            <div className="space-y-1" data-testid="lock-history">
              <button onClick={undoLock} disabled={!undoableLock(state) || busy} title={undoableLock(state) ? `Reverse the GW${undoableLock(state)!.gw} lock-in (local to FPL Intelligence)` : whyNotUndoable(state)} className="w-full rounded-xl border border-fpl-purple/20 bg-white py-1.5 text-xs font-bold text-fpl-purple disabled:opacity-40" data-testid="undo-lock">↶ Undo last Lock in{undoableLock(state) ? ` (GW${undoableLock(state)!.gw})` : ""}</button>
              {!undoableLock(state) && <p className="text-[11px] text-slate-500" data-testid="undo-lock-why">{whyNotUndoable(state)}</p>}
              {history(state).length > 0 && (
                <ul className="space-y-0.5 text-[11px] text-slate-600" data-testid="lock-history-list">
                  {history(state).map((r, i) => (
                    <li key={r.lockedAt + r.gw} className="flex justify-between gap-2"><span>GW{r.gw} locked in · {new Date(r.lockedAt).toLocaleString()}</span><span className={i === 0 && !r.stale && undoableLock(state) ? "font-bold text-fpl-purple" : "text-slate-400"}>{i === 0 && undoableLock(state) ? "can undo" : r.stale ? "re-synced" : "not undoable"}</span></li>
                  ))}
                </ul>
              )}
            </div>
            <DownloadReportButton
              gw={gw}
              buildBody={() => ev && { kind: "my-team", ...body(), starting: ev.proposed.starting.map((p) => p.id), bench: ev.proposed.bench.map((p) => p.id), captain: ev.proposed.captain, vice: ev.proposed.viceCaptain, teamName: state.teamName, ftDerived }}
            />
            <p className="text-[11px] text-slate-500">Accepting a recommendation edits your <b>proposed</b> squad only. Your <b>actual</b> squad changes only when you lock in or re-sync from FPL.</p>
          </div>
        </div>
      </div>

      {/* ---- transfer recommendations ---- */}
      <div className="card space-y-3 p-4" data-testid="transfer-recs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-extrabold text-fpl-purple">Transfer recommendations <Tag kind="model" /></h2>
          <div className="flex gap-1" role="group" aria-label="Transfer horizon">
            {([["five", "Next 5 gameweeks"], ["season", "Remaining season"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setHorizon(k)} data-testid={`horizon-${k}`} aria-pressed={horizon === k} className={`rounded-full px-3 py-1 text-xs font-bold ${horizon === k ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple"}`}>{label}</button>
            ))}
          </div>
          {tr && <span className="text-xs text-slate-500">{tr.freeTransfers} free transfer(s) · bank {fmtGbp(tr.bankTenths / 10)} · judged over GW{tr.horizonGws[0]}–GW{tr.horizonGws[tr.horizonGws.length - 1]} · sell prices used</span>}
        </div>
        {!tr && <p className="p-6 text-center text-sm text-slate-500">Analysing every legal swap…</p>}
        {tr && recommended && (
          <>
            <div className={`rounded-xl border p-3 ${ACTION_STYLE[tr.action]}`} data-testid="recommendation" data-action={tr.action}>
              <div className="text-lg font-black">{tr.headline}</div>
              <p className="text-sm">{tr.reason}</p>
              {tr.action === "save" && <p className="mt-1 text-xs opacity-80">Doing nothing is a valid move: the free transfer carries over (max 5).</p>}
            </div>
            {recommended.transfers.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-slate-600">Recommended moves</h3>
                  <button onClick={() => { applyOption(recommended); }} className="rounded-full bg-fpl-purple px-3 py-1 text-xs font-bold text-white" data-testid="accept-all">Accept all</button></div>
                {recommended.transfers.map((t) => (
                  <TransferCard key={tkey(t)} horizonLabel={horizon === "season" ? "Rest of season (disc.)" : "Next 5 GWs"} t={t} players={tr.players} state={stateOf(t)} onAccept={() => accept(t)} onReject={() => { setRejected((r) => new Set(r).add(tkey(t))); markRec("rejected"); }} onUndo={() => (acceptedKeys.has(tkey(t)) ? unaccept(t) : setRejected((r) => { const n = new Set(r); n.delete(tkey(t)); return n; }))} />
                ))}
              </div>
            )}
            <div>
              <h3 className="mb-1 text-sm font-bold text-slate-600">Save vs transfer: all options compared</h3>
              <OptionsTable horizonLabel={horizon === "season" ? "Season gain (disc.)" : "5-GW gain"} options={tr.options} recommendedN={tr.recommendedN} onApply={applyOption} appliedKey={[...acceptedKeys].sort().join("|")} />
              <p className="mt-1 text-[11px] text-slate-500">{horizon === "season" ? "Net = discounted remaining-season expected-point gain (7% per gameweek) minus −4 per extra transfer; “Best” also credits free transfers left banked, up to the cap of 5. The raw column is the undiscounted gain." : "Net = discounted 5-gameweek expected-point gain minus −4 per extra transfer. “Best” also credits free transfers left banked."}</p>
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-bold text-fpl-purple">Every player: up to five alternatives</summary>
              <div className="mt-2 space-y-2" data-testid="sell-list">
                {tr.sellCandidates.map((s) => {
                  const p = tr.players[s.out] ?? ev?.players[s.out];
                  if (!p) return null;
                  return (
                    <div key={s.out} className="rounded-xl border p-2">
                      <div className="flex items-center gap-2"><Photo src={p.photoUrl} name={p.name} pos={p.pos} size={30} /><div className="text-sm"><b className="text-fpl-purple">{p.name}</b> <span className="text-xs text-slate-500">{p.team} · sell {fmtGbp(s.sellTenths / 10)} · {s.reason}</span></div></div>
                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        {s.alternatives.map((a) => { const q = tr.players[a.in]; return q ? (
                          <button key={a.in} onClick={() => accept(a)} className="flex items-center justify-between gap-2 rounded-lg bg-fpl-bg px-2 py-1 text-left text-xs hover:bg-fpl-purple/10" data-testid="sell-alt">
                            <span><b>{q.name}</b> {q.team} {fmtGbp(q.cost)}</span><span className={`font-bold ${a.net >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{signed(a.net)}</span>
                          </button>) : null; })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          </>
        )}
      </div>

      <ChipPanel data={chips} gw={gw} planChip={plan.chip ?? null} busy={busy} onPlay={play} onCancel={cancelChip} />
      <NewsPanel ids={state.actual.holdings.map((h) => h.id)} gw={gw} />
      <HistoryPanel state={state} onActual={(g, pts) => setState((s) => s && { ...s, snapshots: s.snapshots.map((x) => (x.gw === g ? { ...x, actualPoints: pts } : x)) })} />
      <TeamSettings state={state} meta={meta} onChange={setState} onReset={() => { clearSeason(); setState(null); setEv(null); setTr(null); }} onResync={state.teamId ? resync : undefined} />

      {selected && squadForPitch && (
        <PlayerPanel
          player={[...squadForPitch.starting, ...squadForPitch.bench].find((p) => p.id === selected.id) ?? selected}
          gw={gw}
          squad={squadForPitch}
          prefs={{ mode: "balanced" }}
          isCaptain={squadForPitch.captain === selected.id}
          loadAlts={loadAlts}
          note={plan.chip === "freehit" ? "Free Hit: any legal swap within your total budget (selling prices + bank); nothing is permanent." : `Legal swaps only. Sale proceeds use your selling price (half of any profit); ${ev?.base.freeTransfers ?? 0} free transfer(s), each extra costs −4.`}
          onClose={() => setSelected(null)}
          onReplace={(inId) => replace(selected.id, inId)}
        />
      )}
      {sharing && squadForPitch && <ShareModal squad={squadForPitch} gw={gw} mode="balanced" name={`${state.teamName ?? "My team"}: GW${gw} plan`} onClose={() => setSharing(false)} />}
      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-fpl-purple px-5 py-2 text-sm font-bold text-white shadow-lg" role="status">{toast}</div>}
    </div>
  );
}
