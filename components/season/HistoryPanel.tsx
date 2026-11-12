"use client";
import { useEffect, useState } from "react";
import { api, signed, type PlayerView } from "@/lib/client";
import { CHIP_LABEL, type SeasonState } from "@/lib/season/types";
import type { ChipName } from "@/lib/fpl/types";

export function HistoryPanel({ state, onActual }: { state: SeasonState; onActual: (gw: number, points: number | undefined) => void }) {
  const [names, setNames] = useState<Record<number, string>>({});
  const ids = [...new Set([...state.snapshots.flatMap((s) => s.transfers.flatMap((t) => [t.out, t.in])), ...state.recs.flatMap((r) => r.transfers.flatMap((t) => [t.out, t.in]))])];
  useEffect(() => {
    if (!ids.length) return;
    api<{ players: PlayerView[] }>(`/api/players?ids=${ids.join(",")}&limit=800`).then((r) => setNames(Object.fromEntries(r.players.map((p) => [p.id, p.name])))).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);
  const nm = (id: number) => names[id] ?? `#${id}`;
  const scored = state.snapshots.filter((s) => s.actualPoints !== undefined);
  const mae = scored.length ? scored.reduce((a, s) => a + Math.abs(s.predictedEp - (s.actualPoints ?? 0)), 0) / scored.length : null;
  const bias = scored.length ? scored.reduce((a, s) => a + (s.predictedEp - (s.actualPoints ?? 0)), 0) / scored.length : null;
  const snapGws = new Set(state.snapshots.map((s) => s.gw));
  const actualOnly = state.actualHistory.filter((h) => !snapGws.has(h.event)).slice(-6);

  return (
    <div className="card space-y-4 p-4" data-testid="history-panel">
      <div>
        <h2 className="font-extrabold text-fpl-purple">Predicted vs actual</h2>
        <p className="text-xs text-slate-500">Predictions are saved when you lock in a gameweek and are never rewritten afterwards. Actual points come from FPL (net of transfer hits) or can be typed in.</p>
        {mae !== null && bias !== null && <p className="mt-1 text-sm" data-testid="accuracy-line">Over {scored.length} locked gameweek(s): mean absolute error <b>{mae.toFixed(1)}</b> pts, bias <b>{signed(bias)}</b> (positive = model too optimistic).</p>}
      </div>
      {state.snapshots.length === 0 ? (
        <p className="text-sm text-slate-500">No locked gameweeks yet. Use “Lock in GW” after you have made your moves.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-testid="snapshots">
            <thead><tr className="text-left text-[11px] uppercase text-slate-500"><th>GW</th><th>Moves</th><th>Chip</th><th>Predicted</th><th>Actual</th><th>Error</th></tr></thead>
            <tbody>
              {[...state.snapshots].reverse().map((s) => (
                <tr key={s.gw} className="border-t align-top" data-testid="snapshot-row">
                  <td className="py-1.5 font-bold">GW{s.gw}</td>
                  <td className="text-xs">{s.transfers.length ? s.transfers.map((t) => `${nm(t.out)} → ${nm(t.in)}`).join(", ") : "No transfers"}{s.hitCost ? <span className="ml-1 font-bold text-rose-700">(−{s.hitCost})</span> : null}</td>
                  <td className="text-xs">{s.chip ? CHIP_LABEL[s.chip as ChipName] : "—"}</td>
                  <td className="tabular-nums">{s.predictedEp.toFixed(1)}</td>
                  <td><input type="number" value={s.actualPoints ?? ""} placeholder="–" onChange={(e) => onActual(s.gw, e.target.value === "" ? undefined : Number(e.target.value))} className="w-16 rounded border px-1.5 py-0.5 text-sm" aria-label={`Actual points GW${s.gw}`} /></td>
                  <td className={`tabular-nums font-bold ${s.actualPoints === undefined ? "text-slate-400" : s.predictedEp - s.actualPoints > 0 ? "text-rose-700" : "text-emerald-700"}`}>{s.actualPoints === undefined ? "–" : signed(s.predictedEp - s.actualPoints)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {actualOnly.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Your recent FPL results (actual)</h3>
          <div className="mt-1 flex flex-wrap gap-2">{actualOnly.map((h) => <span key={h.event} className="rounded-lg bg-fpl-bg px-2 py-1 text-xs"><b>GW{h.event}</b> {h.points}{h.transferCost ? ` (−${h.transferCost})` : ""}{h.chip ? ` · ${CHIP_LABEL[h.chip as ChipName] ?? h.chip}` : ""}</span>)}</div>
        </div>
      )}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Recommendation history</h3>
        {state.recs.length === 0 ? <p className="text-sm text-slate-500">Recommendations you view are logged here.</p> : (
          <ul className="mt-1 space-y-1 text-xs" data-testid="recs">
            {state.recs.slice(0, 8).map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-fpl-bg px-2 py-1">
                <b>GW{r.gw}</b><span>{r.label}</span>
                {r.transfers.length > 0 && <span className="text-slate-500">{r.transfers.map((t) => `${nm(t.out)}→${nm(t.in)}`).join(", ")}</span>}
                <span className="text-slate-500">net {signed(r.net)}</span>
                <span className={`ml-auto rounded-full px-2 py-px font-bold ${r.decision === "accepted" ? "bg-emerald-100 text-emerald-800" : r.decision === "rejected" ? "bg-rose-100 text-rose-800" : "bg-slate-200 text-slate-600"}`}>{r.decision}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
