import type { EvalResp } from "@/lib/seasonClient";
import { CHIP_LABEL } from "@/lib/season/types";
import type { ChipName } from "@/lib/fpl/types";
import { fmtGbp, signed } from "@/lib/client";

const Tag = ({ kind }: { kind: "actual" | "model" | "derived" }) => (
  <span
    className={`ml-1 rounded px-1 py-px align-middle text-[9px] font-extrabold uppercase tracking-wide ${
      kind === "actual" ? "bg-emerald-100 text-emerald-800" : kind === "derived" ? "bg-amber-100 text-amber-800" : "bg-fpl-purple/10 text-fpl-purple"
    }`}
    title={kind === "actual" ? "Real FPL data" : kind === "derived" ? "Computed from your FPL history with the official rules; the API does not provide it" : "Model prediction, not a guarantee"}
  >
    {kind}
  </span>
);
export { Tag };

export function SeasonSummary({ ev, gw, ftDerived, teamName }: { ev: EvalResp; gw: number; ftDerived: boolean; teamName?: string }) {
  const p = ev.plan;
  const bank = p.bankTenths;
  const available = ev.base.chips.filter((c) => c.available);
  return (
    <div className="card p-4" data-testid="season-summary">
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{teamName ?? "My team"} · GW{gw}</div>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-5xl font-black text-fpl-purple" data-testid="s-ep">{ev.proposed.expectedPoints.toFixed(1)}</span>
        <Tag kind="model" />
        {p.hitCost > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-sm font-bold text-rose-700" data-testid="s-net">{ev.proposed.netExpectedPoints.toFixed(1)} after −{p.hitCost}</span>}
        {Math.abs(ev.proposed.deltaVsBase) >= 0.05 && <span className={`rounded-full px-2 py-0.5 text-sm font-bold ${ev.proposed.deltaVsBase > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`} data-testid="s-delta">{signed(ev.proposed.deltaVsBase)} vs no change</span>}
      </div>
      <p className="text-[11px] text-slate-500">Projected points for the proposed squad (captain ×2{p.chip === "bboost" ? ", Bench Boost" : p.chip === "3xc" ? ", Triple Captain ×3" : ""}).</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-slate-500" title={`Selling-price value (what the squad would raise). Market value of the 15 is ${fmtGbp(ev.base.marketValueTenths / 10)}; FPL's own "value" figure is market value + bank.`}>Team value (selling)<Tag kind="actual" /></dt><dd className="font-bold" data-testid="s-value">{fmtGbp(p.valueTenths / 10)}</dd></div>
        <div><dt className="text-slate-500">In the bank<Tag kind="actual" /></dt><dd className="font-bold text-emerald-700" data-testid="s-bank">{fmtGbp(bank / 10)}</dd></div>
        <div><dt className="text-slate-500">Free transfers{ftDerived && <Tag kind="derived" />}</dt><dd className="font-bold" data-testid="s-ft">{ev.base.freeTransfers}{p.chip === "wildcard" || p.chip === "freehit" ? " (unlimited, chip)" : p.count > 0 ? ` → ${p.freeUsed} used${p.hits ? `, ${p.hits} hit${p.hits > 1 ? "s" : ""}` : ""}` : ""}</dd></div>
        <div><dt className="text-slate-500">Next week</dt><dd className="font-bold">{p.ftAfter} FT</dd></div>
      </dl>
      <div className="mt-3">
        <div className="text-xs font-semibold text-slate-500">Chips available this half<Tag kind="actual" /></div>
        <div className="mt-1 flex flex-wrap gap-1.5" data-testid="s-chips">
          {ev.base.chips.map((c) => (
            <span key={c.name} className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.available ? "bg-fpl-green/40 text-fpl-purple" : "bg-slate-100 text-slate-400 line-through"}`} title={c.reason}>{CHIP_LABEL[c.name as ChipName]}</span>
          ))}
          {available.length === 0 && <span className="text-xs text-slate-500">None</span>}
        </div>
      </div>
      {p.chip && <div className="mt-3 rounded-lg bg-fpl-purple px-3 py-1.5 text-sm font-bold text-fpl-green" data-testid="s-chip">Chip planned: {CHIP_LABEL[p.chip as ChipName]}</div>}
    </div>
  );
}
