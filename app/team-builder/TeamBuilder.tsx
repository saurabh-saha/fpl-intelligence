"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, saveSquad, type Meta, type PlayerView, type Prefs, type SquadView } from "@/lib/client";
import { GameweekSelector } from "@/components/GameweekSelector";
import { FootballPitch } from "@/components/FootballPitch";
import { BudgetSummary } from "@/components/BudgetSummary";
import { ControlsPanel } from "@/components/ControlsPanel";
import { PlayerPanel } from "@/components/AlternativeSelector";
import { ShareModal } from "@/components/ShareModal";
import { Countdown } from "@/components/Countdown";
import { DownloadReportButton } from "@/components/DownloadReportButton";
import type { Mode } from "@/lib/fpl/types";

type SquadResp = SquadView & { gw: number; method?: string; solveMs?: number; fetchedAt: string; stale: boolean };

export function TeamBuilder() {
  const router = useRouter();
  const sp = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ mode: (sp.get("mode") as Mode) || "balanced" });
  const [squad, setSquad] = useState<SquadResp | null>(null);
  const [original, setOriginal] = useState<SquadResp | null>(null);
  const [undo, setUndo] = useState<SquadResp[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlayerView | null>(null);
  const [sharing, setSharing] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    api<Meta>("/api/bootstrap").then(setMeta).catch((e) => setError(e.message));
  }, []);

  const gw = Number(sp.get("gw")) || meta?.nextGw || 0;

  const generate = useCallback(async (g: number, p: Prefs) => {
    const id = ++req.current;
    setBusy(true);
    setError(null);
    try {
      const s = await api<SquadResp>("/api/optimize", { gw: g, ...p });
      if (id !== req.current) return;
      setSquad(s);
      setOriginal(s);
      setUndo([]);
      setSelected(null);
    } catch (e) {
      if (id === req.current) setError((e as Error).message);
    } finally {
      if (id === req.current) setBusy(false);
    }
  }, []);

  // Auto-generate when landing and whenever the gameweek or strategy changes.
  useEffect(() => {
    if (gw) void generate(gw, prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gw, prefs.mode, generate]);

  const setGw = (g: number) => router.replace(`/team-builder?gw=${g}`);
  const info = meta?.events.find((e) => e.id === gw);
  const evalPrefs = useMemo(() => ({ mode: prefs.mode, budget: prefs.budget }), [prefs.mode, prefs.budget]);

  async function replace(outId: number, inId: number) {
    if (!squad) return;
    try {
      const ids = squad.squadIds.map((id) => (id === outId ? inId : id));
      const s = await api<SquadResp>("/api/evaluate", { gw, squad: ids, ...evalPrefs });
      setUndo((u) => [...u, squad]);
      setSquad(s);
      setSelected(null);
      setToast(`Swapped in ${s.starting.concat(s.bench).find((p) => p.id === inId)?.name}`);
      setTimeout(() => setToast(null), 2200);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const changedIds = useMemo(() => {
    if (!squad || !original) return new Set<number>();
    const o = new Set(original.squadIds);
    return new Set(squad.squadIds.filter((id) => !o.has(id)));
  }, [squad, original]);

  function save() {
    if (!squad) return;
    const name = saveName.trim() || `GW${gw} ${prefs.mode} · ${squad.expectedPoints.toFixed(1)} pts`;
    saveSquad({ name, gw, mode: prefs.mode, ids: squad.squadIds, captain: squad.captain, vice: squad.viceCaptain, ep: squad.expectedPoints });
    setSaveName("");
    setToast(`Saved “${name}”`);
    setTimeout(() => setToast(null), 2200);
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-fpl-purple" data-testid="title">
            {info ? info.name : "Gameweek"} squad
            {info?.isNext && <span className="ml-2 rounded-full bg-fpl-green px-2 py-0.5 align-middle text-xs font-extrabold text-fpl-purple">NEXT</span>}
          </h1>
          {info && (
            <p className="text-sm text-slate-600">
              Deadline {new Date(info.deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · in <b data-testid="countdown"><Countdown to={info.deadline} /></b>
            </p>
          )}
        </div>
        {meta && (
          <p className={`text-xs ${meta.stale ? "text-amber-700" : "text-slate-500"}`} data-testid="freshness">
            {meta.stale ? "⚠ Showing older data (FPL API unreachable) · " : ""}
            Data refreshed {meta.source === "sample" ? "(bundled sample)" : new Date(meta.fetchedAt).toLocaleTimeString()}
          </p>
        )}
      </div>

      {meta && <GameweekSelector meta={meta} value={gw} onChange={setGw} />}

      {error && <div className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700" role="alert" data-testid="error">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative">
          {squad ? (
            <div className={busy ? "opacity-60 transition" : "transition"}>
              <FootballPitch squad={squad} onSelect={setSelected} changedIds={changedIds} />
            </div>
          ) : (
            <div className="pitch grid min-h-[520px] place-items-center text-white" data-testid="loading"><div className="flex items-center gap-3 font-bold"><span className="spinner" /> Building the optimal squad…</div></div>
          )}
          {busy && squad && <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full bg-fpl-purple px-4 py-2 text-sm font-bold text-white shadow"><span className="spinner mr-2 inline-block align-middle" /> Re-optimising…</div>}
        </div>

        <div className="space-y-4">
          {squad && original && <BudgetSummary squad={squad} originalEp={original.expectedPoints} />}
          <div className="card space-y-2 p-4">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { setUndo((u) => { const prev = u[u.length - 1]; if (prev) setSquad(prev); return u.slice(0, -1); }); }} disabled={undo.length === 0} className="rounded-full bg-fpl-bg px-3 py-1.5 text-xs font-bold text-fpl-purple disabled:opacity-40" data-testid="undo">↶ Undo</button>
              <button onClick={() => { if (original) { setSquad(original); setUndo([]); } }} disabled={!original || changedIds.size === 0} className="rounded-full bg-fpl-bg px-3 py-1.5 text-xs font-bold text-fpl-purple disabled:opacity-40" data-testid="restore">Restore original squad</button>
              <button onClick={() => setSharing(true)} disabled={!squad} className="rounded-full bg-fpl-purple px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40" data-testid="share">Share</button>
            </div>
            <div className="flex gap-2">
              <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name this squad" className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm" data-testid="save-name" />
              <button onClick={save} disabled={!squad} className="rounded-lg bg-fpl-green px-3 py-1.5 text-sm font-extrabold text-fpl-purple disabled:opacity-40" data-testid="save">Save</button>
            </div>
            <DownloadReportButton
              gw={gw}
              buildBody={() => squad && { kind: "builder", gw, mode: prefs.mode, budget: prefs.budget, maxOwnership: prefs.maxOwnership, differential: prefs.differential, starting: squad.starting.map((p) => p.id), bench: squad.bench.map((p) => p.id), captain: squad.captain, vice: squad.viceCaptain, originalIds: original?.squadIds }}
            />
            <p className="text-[11px] text-slate-500">Click any player on the pitch to see why they were picked and swap them for a legal alternative.</p>
          </div>
          <ControlsPanel prefs={prefs} onChange={setPrefs} onApply={() => gw && generate(gw, prefs)} busy={busy} />
        </div>
      </div>

      {selected && squad && (
        <PlayerPanel
          player={squad.starting.concat(squad.bench).find((p) => p.id === selected.id) ?? selected}
          gw={gw}
          squad={squad}
          prefs={evalPrefs}
          isCaptain={squad.captain === selected.id}
          onClose={() => setSelected(null)}
          onReplace={(inId) => replace(selected.id, inId)}
        />
      )}
      {sharing && squad && <ShareModal squad={squad} gw={gw} mode={prefs.mode} name={saveName.trim() || undefined} onClose={() => setSharing(false)} />}
      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-fpl-purple px-5 py-2 text-sm font-bold text-white shadow-lg" role="status">{toast}</div>}
    </div>
  );
}
