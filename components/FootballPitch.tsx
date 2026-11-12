"use client";
import type { PlayerView, SquadView } from "@/lib/client";
import { PlayerCard } from "./PlayerCard";

interface Props {
  squad: SquadView;
  onSelect?: (p: PlayerView) => void;
  changedIds?: Set<number>;
}

/** FPL-style pitch: GK at the top, then DEF, MID, FWD; four-man bench underneath. */
export function FootballPitch({ squad, onSelect, changedIds }: Props) {
  const rows = (["GKP", "DEF", "MID", "FWD"] as const).map((pos) => squad.starting.filter((p) => p.pos === pos));
  const role = (id: number) => (id === squad.captain ? "C" : id === squad.viceCaptain ? "V" : undefined);
  const benchLabels = ["GK", "1", "2", "3"];
  return (
    <div>
      <div className="pitch px-2 py-5 sm:px-6" data-testid="pitch">
        <div className="pitch-mid" />
        <div className="pitch-circle" />
        <div className="relative z-10 flex min-h-[470px] flex-col justify-between gap-3 sm:min-h-[640px]">
          {rows.map((row, i) => (
            <div key={i} className="flex items-start justify-around gap-1" data-testid={`row-${["GKP", "DEF", "MID", "FWD"][i]}`}>
              {row.map((p) => (
                <PlayerCard key={p.id} p={p} role={role(p.id)} onClick={() => onSelect?.(p)} changed={changedIds?.has(p.id)} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 rounded-2xl bg-gradient-to-b from-fpl-purple to-fpl-purple-2 px-2 py-3" data-testid="bench">
        <div className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-fpl-green">Substitutes</div>
        <div className="flex items-start justify-around">
          {squad.bench.map((p, i) => (
            <PlayerCard key={p.id} p={p} bench={benchLabels[i]} role={role(p.id)} onClick={() => onSelect?.(p)} changed={changedIds?.has(p.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
