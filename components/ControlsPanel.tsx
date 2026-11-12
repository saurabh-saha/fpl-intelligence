"use client";
import type { Prefs } from "@/lib/client";
import type { Mode } from "@/lib/fpl/types";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "balanced", label: "Balanced", hint: "Max expected points, reliable starters" },
  { id: "safe", label: "Safe", hint: "Minutes, starts and consistency first" },
  { id: "aggressive", label: "Differential", hint: "Low-owned players with strong underlying numbers" },
];
const FORMATIONS = ["3-4-3", "3-5-2", "4-3-3", "4-4-2", "4-5-1", "5-2-3", "5-3-2", "5-4-1"];

export function ControlsPanel({ prefs, onChange, onApply, busy }: { prefs: Prefs; onChange: (p: Prefs) => void; onApply: () => void; busy: boolean }) {
  const set = (patch: Partial<Prefs>) => onChange({ ...prefs, ...patch });
  return (
    <div className="card space-y-4 p-4" data-testid="controls">
      <div>
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Strategy</div>
        <div className="grid grid-cols-3 gap-1.5">
          {MODES.map((m) => (
            <button key={m.id} title={m.hint} data-testid={`mode-${m.id}`} onClick={() => set({ mode: m.id })} className={`rounded-xl px-2 py-2 text-xs font-bold ${prefs.mode === m.id ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple hover:bg-fpl-purple/10"}`}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">{MODES.find((m) => m.id === prefs.mode)?.hint}</p>
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
        <label className="block">
          <span className="text-xs font-semibold text-slate-500">Differential: {Math.round((prefs.differential ?? (prefs.mode === "aggressive" ? 0.6 : 0)) * 100)}%</span>
          <input type="range" min="0" max="1" step="0.05" value={prefs.differential ?? (prefs.mode === "aggressive" ? 0.6 : 0)} onChange={(e) => set({ differential: Number(e.target.value) })} className="mt-2 w-full accent-fpl-purple" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!prefs.favourFixtureRuns} onChange={(e) => set({ favourFixtureRuns: e.target.checked })} className="h-4 w-4 accent-fpl-purple" />
        Favour upcoming fixture runs (next 3 GWs)
      </label>
      <button onClick={onApply} disabled={busy} data-testid="apply" className="flex w-full items-center justify-center gap-2 rounded-xl bg-fpl-purple py-2.5 text-sm font-extrabold text-white hover:bg-fpl-purple-2 disabled:opacity-60">
        {busy && <span className="spinner" />} Generate squad
      </button>
    </div>
  );
}
