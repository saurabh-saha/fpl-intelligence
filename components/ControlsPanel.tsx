"use client";
import type { Prefs } from "@/lib/client";
import type { Mode } from "@/lib/fpl/types";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "balanced", label: "Balanced", hint: "Max expected points, reliable starters" },
  { id: "safe", label: "Safe", hint: "Minutes, starts and consistency first" },
  { id: "aggressive", label: "Differential", hint: "Low-owned players with strong underlying numbers" },
];
const FORMATIONS = ["3-4-3", "3-5-2", "4-3-3", "4-4-2", "4-5-1", "5-2-3", "5-3-2", "5-4-1"];

/** Optional fifth strategy. When omitted the panel behaves exactly as before. */
export interface SeasonLongControl {
  active: boolean;
  onSelect: (on: boolean) => void;
  /** first gameweek of the horizon (the selected gameweek) */
  from: number;
  /** last gameweek of the season */
  last: number;
  horizonEnd: number;
  onHorizonEnd: (gw: number) => void;
}

export function ControlsPanel({ prefs, onChange, onApply, busy, seasonLong }: { prefs: Prefs; onChange: (p: Prefs) => void; onApply: () => void; busy: boolean; seasonLong?: SeasonLongControl }) {
  const set = (patch: Partial<Prefs>) => onChange({ ...prefs, ...patch });
  const sl = seasonLong?.active ?? false;
  return (
    <div className="card space-y-4 p-4" data-testid="controls">
      <div>
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Strategy</div>
        <div className={`grid gap-1.5 ${seasonLong ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
          {MODES.map((m) => (
            <button key={m.id} title={m.hint} data-testid={`mode-${m.id}`} onClick={() => { set({ mode: m.id }); seasonLong?.onSelect(false); }} className={`rounded-xl px-2 py-2 text-xs font-bold ${prefs.mode === m.id && !sl ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple hover:bg-fpl-purple/10"}`}>
              {m.label}
            </button>
          ))}
          {seasonLong && (
            <button title="Maximise expected points across the remaining season." data-testid="mode-season-long" onClick={() => seasonLong.onSelect(true)} className={`rounded-xl px-2 py-2 text-xs font-bold ${sl ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple hover:bg-fpl-purple/10"}`}>
              Season Long
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-500" data-testid="strategy-hint">{sl ? "Maximise expected points across the remaining season." : MODES.find((m) => m.id === prefs.mode)?.hint}</p>
        {seasonLong && sl && (
          <div className="mt-2 space-y-2 rounded-xl bg-fpl-purple/5 p-3 text-xs text-slate-700" data-testid="season-long-controls">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-fpl-purple">Planning horizon</span>
              <span data-testid="horizon-label">GW{seasonLong.from} to GW{seasonLong.horizonEnd} ({seasonLong.horizonEnd - seasonLong.from + 1} gameweeks)</span>
            </div>
            <label className="flex items-center gap-2">
              <span className="font-semibold text-slate-500">Horizon ends at GW</span>
              <input type="number" min={seasonLong.from} max={seasonLong.last} value={seasonLong.horizonEnd} onChange={(e) => seasonLong.onHorizonEnd(Math.min(seasonLong.last, Math.max(seasonLong.from, Number(e.target.value) || seasonLong.last)))} className="w-16 rounded-lg border px-2 py-1" data-testid="horizon-end" />
              <button type="button" onClick={() => seasonLong.onHorizonEnd(seasonLong.last)} className="rounded-full bg-white px-2 py-0.5 font-bold text-fpl-purple">Season end</button>
            </label>
            <p>Prioritises <b>long-term value over immediate gameweek points</b>: distant gameweeks count less (7% discount per gameweek) and this week's xPts can be lower than Balanced's. Weekly transfers for this strategy are under <a href="/my-team" className="font-bold underline">My Team</a> (transfer horizon: remaining season).</p>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="block">
          <span className="text-xs font-semibold text-slate-500">Budget (£m)</span>
          <input type="number" step="0.1" min="30" max="100" value={prefs.budget ?? 100} onChange={(e) => set({ budget: e.target.value === "" ? undefined : Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-2 py-1.5" data-testid="budget" />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-500">Formation</span>
          <select value={prefs.formation ?? ""} onChange={(e) => set({ formation: e.target.value || undefined })} className="mt-1 w-full rounded-lg border px-2 py-1.5" data-testid="formation-select">
            <option value="">Auto (best)</option>
            {FORMATIONS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-500">Max ownership %</span>
          <input type="number" min="1" max="100" placeholder="No cap" value={prefs.maxOwnership ?? ""} onChange={(e) => set({ maxOwnership: e.target.value === "" ? undefined : Number(e.target.value) })} className="mt-1 w-full rounded-lg border px-2 py-1.5" />
        </label>
        {!sl && (
          <label className="block">
            <span className="text-xs font-semibold text-slate-500">Differential: {Math.round((prefs.differential ?? (prefs.mode === "aggressive" ? 0.6 : 0)) * 100)}%</span>
            <input type="range" min="0" max="1" step="0.05" value={prefs.differential ?? (prefs.mode === "aggressive" ? 0.6 : 0)} onChange={(e) => set({ differential: Number(e.target.value) })} className="mt-2 w-full accent-fpl-purple" />
          </label>
        )}
      </div>
      {!sl && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!prefs.favourFixtureRuns} onChange={(e) => set({ favourFixtureRuns: e.target.checked })} className="h-4 w-4 accent-fpl-purple" />
          Favour upcoming fixture runs (next 3 GWs)
        </label>
      )}
      <button onClick={onApply} disabled={busy} data-testid="apply" className="flex w-full items-center justify-center gap-2 rounded-xl bg-fpl-purple py-2.5 text-sm font-extrabold text-white hover:bg-fpl-purple-2 disabled:opacity-60">
        {busy && <span className="spinner" />} Generate squad
      </button>
    </div>
  );
}
