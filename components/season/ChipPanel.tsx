"use client";
import type { ChipsResp } from "@/lib/seasonClient";
import type { ChipName } from "@/lib/fpl/types";
import { CHIP_LABEL } from "@/lib/season/types";
import { signed } from "@/lib/client";

const RULE: Record<ChipName, string> = {
  wildcard: "Unlimited permanent transfers, no hit. Banked free transfers are kept.",
  freehit: "Unlimited transfers for one gameweek only; the squad reverts after. Not GW1, not two weeks running.",
  bboost: "All 15 players score this gameweek.",
  "3xc": "Your captain scores triple instead of double.",
};
const VERDICT = { "use-now": "bg-emerald-100 text-emerald-800", "use-soon": "bg-amber-100 text-amber-800", save: "bg-sky-100 text-sky-800", unavailable: "bg-slate-100 text-slate-500" } as const;
const VERDICT_LABEL = { "use-now": "Use now", "use-soon": "Use before it expires", save: "Save it", unavailable: "Unavailable" } as const;

export function ChipPanel({ data, gw, planChip, busy, onPlay, onCancel }: { data: ChipsResp | null; gw: number; planChip: string | null; busy: boolean; onPlay: (c: ChipName) => void; onCancel: () => void }) {
  return (
    <div className="card p-4" data-testid="chip-panel">
      <h2 className="font-extrabold text-fpl-purple">Chip strategy</h2>
      <p className="text-xs text-slate-500">Two sets of four chips per season; set 1 expires at the GW19 deadline. Only one chip per gameweek.</p>
      {!data && <p className="p-4 text-center text-sm text-slate-500">Analysing chips…</p>}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {data?.advice.map((a) => (
          <div key={a.chip} className={`rounded-xl border p-3 ${planChip === a.chip ? "border-fpl-purple bg-fpl-purple/5" : ""}`} data-testid={`chip-${a.chip}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-extrabold text-fpl-purple">{a.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${VERDICT[a.verdict]}`}>{VERDICT_LABEL[a.verdict]}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">{RULE[a.chip]}</p>
            <p className="mt-1 text-xs text-slate-700">{a.text}</p>
            {a.options.length > 0 && (
              <div className="mt-2 flex items-end gap-1" title="Estimated gain by gameweek" style={{ maxWidth: `${Math.max(a.options.length, 3) * 12.5}%` }}>
                {a.options.map((o) => {
                  const max = Math.max(...a.options.map((x) => x.gain), 1);
                  return (
                    <div key={o.gw} className="flex flex-1 flex-col items-center" title={`GW${o.gw}: ${signed(o.gain)} pts${o.doubleTeams ? `, ${o.doubleTeams} double` : ""}${o.blankTeams ? `, ${o.blankTeams} blank` : ""}`}>
                      <div className={`w-full rounded-t ${o.gw === gw ? "bg-fpl-purple" : "bg-fpl-purple/40"}`} style={{ height: `${Math.max(3, (Math.max(o.gain, 0) / max) * 36)}px` }} />
                      <span className="text-[9px] text-slate-500">{o.gw}{o.doubleTeams ? "D" : o.blankTeams ? "B" : ""}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-2">
              {planChip === a.chip ? (
                <button onClick={onCancel} className="rounded-full bg-fpl-bg px-3 py-1 text-xs font-bold text-fpl-purple" data-testid={`cancel-${a.chip}`}>Cancel chip</button>
              ) : (
                <button disabled={!a.available || busy || !!planChip} onClick={() => onPlay(a.chip)} className="rounded-full bg-fpl-purple px-3 py-1 text-xs font-bold text-white disabled:opacity-40" data-testid={`play-${a.chip}`}>
                  Plan {CHIP_LABEL[a.chip]} in GW{gw}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
