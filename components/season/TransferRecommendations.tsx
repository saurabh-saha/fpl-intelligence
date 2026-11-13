"use client";
import { fmtGbp, signed, type PlayerView } from "@/lib/client";
import type { TransfersResp } from "@/lib/seasonClient";
import type { TransferDetail, TransferOption } from "@/lib/season/transfers";
import { Photo } from "../Photo";
import { Fixtures } from "../FixtureDifficulty";

const ACTION_STYLE = { save: "bg-sky-50 border-sky-300 text-sky-900", transfer: "bg-emerald-50 border-emerald-300 text-emerald-900", hit: "bg-amber-50 border-amber-300 text-amber-900" } as const;

function PlayerMini({ p, sell }: { p: PlayerView; sell?: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Photo src={p.photoUrl} name={p.name} pos={p.pos} size={36} />
      <div className="min-w-0">
        <div className="truncate text-sm font-extrabold text-fpl-purple">{p.name}</div>
        <div className="text-[11px] text-slate-500">{p.team} · {p.pos} · {sell !== undefined ? `sell ${fmtGbp(sell / 10)}` : fmtGbp(p.cost)}</div>
      </div>
    </div>
  );
}

export function TransferCard({ t, players, state, onAccept, onReject, onUndo, horizonLabel = "Next 5 GWs" }: { t: TransferDetail & { gainRemainingSeasonRaw?: number }; players: TransfersResp["players"]; state: "pending" | "accepted" | "rejected"; onAccept: () => void; onReject: () => void; onUndo: () => void; horizonLabel?: string }) {
  const o = players[t.out];
  const i = players[t.in];
  if (!o || !i) return null;
  return (
    <div className={`rounded-xl border p-3 ${state === "accepted" ? "border-emerald-400 bg-emerald-50/60" : state === "rejected" ? "opacity-50" : "bg-white"}`} data-testid="transfer-card" data-state={state}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <PlayerMini p={o} sell={t.sellTenths} />
        <span className="text-lg text-slate-400">→</span>
        <PlayerMini p={i} />
      </div>
      <div className={`mt-2 grid grid-cols-2 gap-2 text-center text-xs ${t.gainRemainingSeasonRaw !== undefined ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        <Stat label="Price diff" value={`${t.priceDiffTenths > 0 ? "+" : ""}${(t.priceDiffTenths / 10).toFixed(1)}m`} />
        <Stat label="This GW" value={`${signed(t.gainGw)} pts`} good={t.gainGw >= 0} />
        <Stat label={horizonLabel} value={`${signed(t.gainHorizon)} pts`} good={t.gainHorizon >= 0} />
        {t.gainRemainingSeasonRaw !== undefined && <Stat label="Rest of season (raw)" value={`${signed(t.gainRemainingSeasonRaw, 0)} pts`} good={t.gainRemainingSeasonRaw >= 0} />}
        <Stat label="Deduction" value={t.deduction ? `−${t.deduction}` : "free"} good={!t.deduction} />
        <Stat label="Net gain" value={`${signed(t.net)}`} good={t.net >= 0} bold />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
        <Fixtures fixtures={i.fixtures} />
        {t.differential && <span className="rounded bg-fpl-pink/10 px-1.5 py-0.5 font-bold text-fpl-pink">differential</span>}
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold">{i.confidence} confidence</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-700">{t.explanation}</p>
      <div className="mt-2 flex gap-2">
        {state === "pending" ? (
          <>
            <button onClick={onAccept} data-testid="accept" className="rounded-full bg-fpl-purple px-3 py-1 text-xs font-bold text-white hover:bg-fpl-purple-2">Accept</button>
            <button onClick={onReject} data-testid="reject" className="rounded-full bg-fpl-bg px-3 py-1 text-xs font-bold text-fpl-purple">Reject</button>
          </>
        ) : (
          <button onClick={onUndo} className="rounded-full bg-fpl-bg px-3 py-1 text-xs font-bold text-fpl-purple">{state === "accepted" ? "Remove from plan" : "Reconsider"}</button>
        )}
        {state === "accepted" && <span className="self-center text-xs font-bold text-emerald-700">✓ in your plan</span>}
      </div>
    </div>
  );
}

const Stat = ({ label, value, good, bold }: { label: string; value: string; good?: boolean; bold?: boolean }) => (
  <div className="rounded-lg bg-fpl-bg px-1 py-1"><div className="text-[10px] font-semibold text-slate-500">{label}</div><div className={`${bold ? "text-sm font-black" : "font-bold"} ${good === undefined ? "" : good ? "text-emerald-700" : "text-rose-700"}`}>{value}</div></div>
);

export function OptionsTable({ options, recommendedN, onApply, appliedKey, horizonLabel = "5-GW gain" }: { options: TransferOption[]; recommendedN: number; onApply: (o: TransferOption) => void; appliedKey: string; horizonLabel?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm" data-testid="options-table">
        <thead><tr className="text-left text-[11px] uppercase text-slate-500"><th className="py-1">Option</th><th>This GW</th><th>{horizonLabel}</th><th>Hit</th><th>Net</th><th>After</th><th /></tr></thead>
        <tbody>
          {options.map((o) => {
            const key = o.transfers.map((t) => `${t.out}>${t.in}`).sort().join("|");
            return (
              <tr key={o.n} className={`border-t ${o.n === recommendedN ? "bg-fpl-green/15 font-bold" : ""}`} data-testid={`option-${o.n}`}>
                <td className="py-1.5">{o.label}{o.n === recommendedN && <span className="ml-1 rounded bg-fpl-purple px-1.5 text-[10px] text-fpl-green">BEST</span>}</td>
                <td className="tabular-nums">{signed(o.gainGw)}</td>
                <td className="tabular-nums">{signed(o.gainHorizon)}</td>
                <td className="tabular-nums">{o.hitCost ? `−${o.hitCost}` : "0"}</td>
                <td className="tabular-nums">{signed(o.net)}</td>
                <td className="tabular-nums">{o.ftAfter} FT</td>
                <td className="text-right">{appliedKey === key ? <span className="text-xs text-emerald-700">applied</span> : <button onClick={() => onApply(o)} className="rounded-full bg-fpl-bg px-2.5 py-1 text-xs font-bold text-fpl-purple">{o.n === 0 ? "Clear" : "Apply"}</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export { ACTION_STYLE };
