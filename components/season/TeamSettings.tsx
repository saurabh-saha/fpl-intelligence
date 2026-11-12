"use client";
import { useRef } from "react";
import type { Meta } from "@/lib/client";
import { CHIP_LABEL, type ChipName, type SeasonState } from "@/lib/season/types";

const NAMES: ChipName[] = ["wildcard", "freehit", "bboost", "3xc"];

/** Manual overrides for anything FPL does not expose, plus backup/restore of the whole season. */
export function TeamSettings({ state, meta, onChange, onReset, onResync }: { state: SeasonState; meta: Meta | null; onChange: (s: SeasonState) => void; onReset: () => void; onResync?: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const a = state.actual;
  const half = a.gw >= 20 ? [20, 38] : [1, 19];
  const usedHalf = (n: ChipName) => a.chipsUsed.find((c) => c.name === n && c.event >= half[0] && c.event <= half[1]);
  const setChip = (n: ChipName, used: boolean) => {
    const rest = a.chipsUsed.filter((c) => !(c.name === n && c.event >= half[0] && c.event <= half[1]));
    onChange({ ...state, actual: { ...a, chipsUsed: used ? [...rest, { name: n, event: Math.max(half[0], 2) }] : rest } });
  };
  return (
    <details className="card p-4" data-testid="team-settings">
      <summary className="cursor-pointer font-extrabold text-fpl-purple">Team settings & backup</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm"><span className="text-xs font-semibold text-slate-500">Free transfers (manual override)</span>
          <input type="number" min={0} max={5} value={a.freeTransfers} onChange={(e) => onChange({ ...state, actual: { ...a, freeTransfers: Math.min(5, Math.max(0, Number(e.target.value) || 0)) } })} className="mt-1 w-full rounded-lg border px-2 py-1.5" data-testid="set-ft" /></label>
        <label className="block text-sm"><span className="text-xs font-semibold text-slate-500">Bank £m (manual override)</span>
          <input type="number" step="0.1" min={0} value={(a.bankTenths / 10).toFixed(1)} onChange={(e) => onChange({ ...state, actual: { ...a, bankTenths: Math.max(0, Math.round(Number(e.target.value) * 10) || 0) } })} className="mt-1 w-full rounded-lg border px-2 py-1.5" data-testid="set-bank" /></label>
      </div>
      <div className="mt-3">
        <div className="text-xs font-semibold text-slate-500">Chips already used this half (GW{half[0]}–{half[1]})</div>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {NAMES.map((n) => (
            <label key={n} className="flex items-center gap-1.5"><input type="checkbox" className="accent-fpl-purple" checked={!!usedHalf(n)} onChange={(e) => setChip(n, e.target.checked)} /> {CHIP_LABEL[n]}{usedHalf(n) ? ` (GW${usedHalf(n)!.event})` : ""}</label>
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold">
        {onResync && <button onClick={onResync} className="rounded-full bg-fpl-purple px-3 py-1.5 text-white" data-testid="resync">Re-sync from FPL (team {state.teamId})</button>}
        <button onClick={() => { const b = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(b); const l = document.createElement("a"); l.href = u; l.download = "fpl-season.json"; l.click(); URL.revokeObjectURL(u); }} className="rounded-full bg-fpl-bg px-3 py-1.5 text-fpl-purple">Export backup</button>
        <button onClick={() => file.current?.click()} className="rounded-full bg-fpl-bg px-3 py-1.5 text-fpl-purple">Import backup</button>
        <input ref={file} type="file" accept="application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const s = JSON.parse(await f.text()); if (s?.version === 1 && s.actual?.holdings) onChange(s); } catch { /* ignore invalid file */ } }} />
        <button onClick={() => { if (confirm("Delete your season data from this browser?")) onReset(); }} className="rounded-full bg-rose-50 px-3 py-1.5 text-rose-700" data-testid="reset-season">Reset season</button>
      </div>
      {meta && <p className="mt-2 text-[11px] text-slate-500">Rules in force: 1 free transfer per GW, bank up to 5, −4 per extra transfer, selling price keeps half of any price rise.</p>}
    </details>
  );
}
