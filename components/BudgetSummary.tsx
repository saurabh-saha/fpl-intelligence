import type { SquadView } from "@/lib/client";
import { fmtGbp, signed } from "@/lib/client";

export function BudgetSummary({ squad, originalEp, budget = 100 }: { squad: SquadView; originalEp?: number; budget?: number }) {
  const delta = originalEp !== undefined ? squad.expectedPoints - originalEp : 0;
  const cap = squad.starting.find((p) => p.id === squad.captain);
  const vice = squad.starting.find((p) => p.id === squad.viceCaptain);
  const counts = new Map<string, number>();
  [...squad.starting, ...squad.bench].forEach((p) => counts.set(p.team, (counts.get(p.team) ?? 0) + 1));
  const maxClub = Math.max(...counts.values());
  return (
    <div className="card p-4" data-testid="summary">
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Projected points</div>
      <div className="flex items-baseline gap-2">
        <span className="text-5xl font-black text-fpl-purple" data-testid="ep">{squad.expectedPoints.toFixed(1)}</span>
        {Math.abs(delta) >= 0.05 && (
          <span className={`rounded-full px-2 py-0.5 text-sm font-bold ${delta > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`} data-testid="delta">
            {signed(delta)} vs original
          </span>
        )}
      </div>
      <p className="text-[11px] text-slate-500">Model estimate incl. captain ×2. Not a guaranteed result.</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-slate-500">Formation</dt><dd className="font-bold" data-testid="formation">{squad.formation}</dd></div>
        <div><dt className="text-slate-500">Squad value</dt><dd className="font-bold">{fmtGbp(squad.totalCost)}</dd></div>
        <div><dt className="text-slate-500">In the bank</dt><dd className="font-bold text-emerald-700" data-testid="remaining">{fmtGbp(squad.remaining)}</dd></div>
        <div><dt className="text-slate-500">Max per club</dt><dd className="font-bold">{maxClub} / 3</dd></div>
        <div><dt className="text-slate-500">Captain</dt><dd className="font-bold">{cap?.name} <span className="text-xs font-semibold text-slate-500">{cap?.ep.toFixed(1)}</span></dd></div>
        <div><dt className="text-slate-500">Vice</dt><dd className="font-bold">{vice?.name} <span className="text-xs font-semibold text-slate-500">{vice?.ep.toFixed(1)}</span></dd></div>
      </dl>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" aria-label="Budget used">
        <div className="h-full bg-gradient-to-r from-fpl-purple to-fpl-pink" style={{ width: `${Math.min(100, (squad.totalCost / budget) * 100)}%` }} />
      </div>
    </div>
  );
}
