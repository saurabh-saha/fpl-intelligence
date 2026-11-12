"use client";
import type { Meta } from "@/lib/client";

/** Clickable gameweek pills. Starts at the next gameweek and scrolls horizontally through the season. */
export function GameweekSelector({ meta, value, onChange }: { meta: Meta; value: number; onChange: (gw: number) => void }) {
  const upcoming = meta.events.filter((e) => !e.finished);
  return (
    <div className="scroll-hide -mx-1 flex gap-2 overflow-x-auto px-1 py-1" role="tablist" aria-label="Gameweek">
      {upcoming.map((e) => {
        const active = e.id === value;
        return (
          <button
            key={e.id}
            role="tab"
            aria-selected={active}
            data-testid={`gw-${e.id}`}
            onClick={() => onChange(e.id)}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm font-bold transition ${
              active ? "border-fpl-purple bg-fpl-purple text-white shadow" : "border-fpl-purple/20 bg-white text-fpl-purple hover:border-fpl-purple/60"
            }`}
          >
            GW {e.id}
            {e.isNext && <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] ${active ? "bg-fpl-green text-fpl-purple" : "bg-fpl-purple/10"}`}>NEXT</span>}
          </button>
        );
      })}
    </div>
  );
}
