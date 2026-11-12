import type { PlayerView } from "@/lib/client";
import { Photo } from "./Photo";
import { Fixtures } from "./FixtureDifficulty";

const rows: [string, (p: PlayerView) => string | number][] = [
  ["Price (£m)", (p) => p.cost.toFixed(1)],
  ["Expected points", (p) => p.ep.toFixed(2)],
  ["Confidence", (p) => p.confidence],
  ["Goals", (p) => p.goals],
  ["Assists", (p) => p.assists],
  ["xG", (p) => p.xG],
  ["xA", (p) => p.xA],
  ["Minutes", (p) => p.minutes],
  ["Form", (p) => p.form],
  ["Total points", (p) => p.totalPoints],
  ["Start probability", (p) => `${Math.round(p.startProb * 100)}%`],
  ["Ownership", (p) => `${p.ownership}%`],
];

export function PlayerComparison({ players, onClose }: { players: PlayerView[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" data-testid="comparison">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close" />
      <div className="card relative max-h-[90vh] w-full max-w-3xl overflow-auto p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-extrabold text-fpl-purple">Player comparison</h2><button onClick={onClose} className="rounded-full bg-fpl-bg px-3 py-1 text-sm font-bold">✕</button></div>
        <table className="w-full text-sm">
          <thead>
            <tr><th />{players.map((p) => (
              <th key={p.id} className="p-2 text-center align-bottom"><div className="flex flex-col items-center gap-1"><Photo src={p.photoUrl} name={p.name} pos={p.pos} size={56} /><span className="font-extrabold text-fpl-purple">{p.name}</span><span className="text-xs font-semibold text-slate-500">{p.team} · {p.pos}</span></div></th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => {
              const vals = players.map((p) => Number(String(f(p)).replace(/[^0-9.]/g, "")));
              const best = Math.max(...vals);
              return (
                <tr key={label} className="border-t">
                  <td className="py-1.5 pr-2 text-slate-500">{label}</td>
                  {players.map((p, i) => <td key={p.id} className={`p-1.5 text-center tabular-nums ${vals[i] === best && label !== "Price (£m)" && Number.isFinite(best) ? "font-black text-emerald-700" : ""}`}>{f(p)}</td>)}
                </tr>
              );
            })}
            <tr className="border-t"><td className="py-1.5 pr-2 text-slate-500">Next fixture</td>{players.map((p) => <td key={p.id} className="p-1.5 text-center"><Fixtures fixtures={p.fixtures} /></td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
