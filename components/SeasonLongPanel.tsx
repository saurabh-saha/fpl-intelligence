"use client";
import { useEffect, useState } from "react";
import { api, fmtGbp, type SquadView } from "@/lib/client";

interface Row {
  id: number; name: string; pos: string; club: string; priceM: number; role: "starting" | "bench"; slot: number; isCaptain: boolean; isVice: boolean;
  xptsNextGw: number; xptsRestOfSeasonDiscounted: number; xptsRestOfSeasonRaw: number; restAvgPerGw: number; startProb: number; expMinutes: number; availabilityNow: number;
  rankInPosition: number; inCoreXI: boolean; fdrNext8: number; fdrRest: number; reasons: string[]; benchReason?: string;
}
interface Resp {
  horizon: { from: number; to: number; gameweeks: number; discountPerGameweek: number; discountSum: number; limitations: string[] };
  summary: { xiThisGw: number; squad15ThisGw: number; xiRestOfSeasonRaw: number; xiRestOfSeasonDiscounted: number; squad15RestOfSeasonRaw: number; squad15RestOfSeasonDiscounted: number; gameweeks: number };
  rows: Row[];
}

/** Rest-of-season details and reasons for the squad exactly as shown on the pitch (also after the user swaps players). */
export function SeasonLongPanel({ squad, gw, horizonEnd }: { squad: SquadView; gw: number; horizonEnd?: number }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = [...squad.starting, ...squad.bench].map((p) => p.id).join(",") + `|${squad.captain}|${squad.viceCaptain}`;
  useEffect(() => {
    let live = true;
    setErr(null);
    api<Resp>("/api/strategies/season-long/players", { gw, horizonEnd, starting: squad.starting.map((p) => p.id), bench: squad.bench.map((p) => p.id), captain: squad.captain, vice: squad.viceCaptain })
      .then((r) => live && setD(r))
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gw, horizonEnd]);

  if (err) return <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{err}</div>;
  if (!d) return <div className="card p-4 text-sm text-slate-500" data-testid="sl-loading">Loading remaining-season details…</div>;
  const s = d.summary;
  const cards: [string, string, string][] = [
    [`Starting XI, GW${gw}`, s.xiThisGw.toFixed(1), "xPts incl. captain"],
    [`15-man squad, GW${gw}`, s.squad15ThisGw.toFixed(1), "xPts, all players"],
    [`Starting XI, GW${d.horizon.from}-${d.horizon.to}`, s.xiRestOfSeasonRaw.toFixed(0), `raw · ${s.xiRestOfSeasonDiscounted.toFixed(0)} discounted`],
    [`15-man squad, GW${d.horizon.from}-${d.horizon.to}`, s.squad15RestOfSeasonRaw.toFixed(0), `raw · ${s.squad15RestOfSeasonDiscounted.toFixed(0)} discounted`],
  ];
  return (
    <div className="card space-y-3 p-4" data-testid="season-long-panel">
      <div>
        <h2 className="font-extrabold text-fpl-purple">Season Long: rest-of-season view <span className="text-xs font-semibold text-slate-500">GW{d.horizon.from} to GW{d.horizon.to}, {d.horizon.gameweeks} gameweeks, {Math.round((1 - d.horizon.discountPerGameweek) * 100)}% discount per gameweek</span></h2>
        <p className="text-xs text-slate-600">Rest-of-season xPts are <b>model estimates</b> that assume one fixture per club per gameweek as scheduled and treat injuries with an assumed recovery curve. "Next GW" xPts use the shared model, so they are comparable with every other strategy.</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="sl-summary">
        {cards.map(([l, v, sub]) => <div key={l} className="rounded-xl bg-fpl-bg p-2 text-center"><div className="text-[11px] font-semibold text-slate-500">{l}</div><div className="text-xl font-black text-fpl-purple">{v}</div><div className="text-[10px] text-slate-500">{sub}</div></div>)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs" data-testid="sl-table">
          <thead><tr className="text-left uppercase text-slate-500"><th className="py-1">Player</th><th className="text-right">Price</th><th className="text-right">Next GW</th><th className="text-right">Rest of season</th><th className="text-right">Start / xMin</th><th className="pl-3">Why</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id} className={`border-t align-top ${r.role === "bench" ? "bg-slate-50" : ""}`} data-testid={`sl-row-${r.role}`}>
                <td className="py-1.5 pr-2"><div className="font-bold text-fpl-purple">{r.name}{r.isCaptain ? " (C)" : r.isVice ? " (V)" : ""}</div><div className="text-[10px] text-slate-500">{r.pos} · {r.club} · {r.role === "starting" ? "XI" : `bench ${r.slot}`}{r.inCoreXI ? " · core" : ""}</div></td>
                <td className="text-right tabular-nums">{fmtGbp(r.priceM)}</td>
                <td className="text-right tabular-nums">{r.xptsNextGw.toFixed(2)}</td>
                <td className="text-right tabular-nums"><b>{r.xptsRestOfSeasonRaw.toFixed(0)}</b><div className="text-[10px] text-slate-500">{r.xptsRestOfSeasonDiscounted.toFixed(1)} disc · {r.restAvgPerGw.toFixed(1)}/GW</div></td>
                <td className="text-right tabular-nums">{Math.round(r.startProb * 100)}% / {r.expMinutes}</td>
                <td className="pl-3 text-[11px] leading-snug text-slate-700">{r.role === "bench" && r.benchReason ? <b className="text-slate-900">Bench: {r.benchReason} </b> : null}{r.reasons.slice(0, r.role === "bench" ? 2 : 3).join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="text-xs text-slate-600" data-testid="sl-limitations">
        <summary className="cursor-pointer font-bold text-fpl-purple">Assumptions and limitations of long-range projections</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">{d.horizon.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </details>
    </div>
  );
}
