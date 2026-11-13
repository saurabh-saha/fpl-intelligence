"use client";
import type { PlayerView } from "@/lib/client";
import { Photo } from "./Photo";

interface Props {
  p: PlayerView;
  role?: "C" | "V";
  onClick?: () => void;
  changed?: boolean;
  bench?: string;
}

/** Player token for the pitch: photo, name pill, price + expected points, armband and warning markers. */
export function PlayerCard({ p, role, onClick, changed, bench }: Props) {
  const next = p.fixtures[0];
  const warn = p.warnings.length > 0 && (p.availability < 1 || p.startProb < 0.6);
  return (
    <button
      onClick={onClick}
      data-testid={`player-${p.id}`}
      className="chip-btn group relative flex w-[74px] flex-col items-center text-center sm:w-[104px]"
      aria-label={`${p.name}, ${p.pos}, ${p.ep.toFixed(1)} expected points`}
    >
      <span className={`relative rounded-full ${changed ? "ring-4 ring-fpl-cyan ring-offset-2 ring-offset-transparent" : ""}`}>
        <span className="sm:hidden"><Photo src={p.photoUrl} name={p.name} pos={p.pos} size={44} /></span>
        <span className="hidden sm:block"><Photo src={p.photoUrl} name={p.name} pos={p.pos} size={60} /></span>
        {role && (
          <span className={`absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-white text-[11px] font-black shadow ${role === "C" ? "bg-fpl-purple text-fpl-green" : "bg-white text-fpl-purple"}`}>
            {role}
          </span>
        )}
        {p.newsImpact && (
          <span className="absolute -bottom-0.5 -left-1 grid h-5 w-5 place-items-center rounded-full bg-sky-500 text-[10px] shadow" title={`News: ${p.newsImpact.baseXpts.toFixed(1)} → ${p.newsImpact.newsAdjustedXpts.toFixed(1)} xPts. ${p.newsImpact.adjustmentReasons[0] ?? ""}`} data-testid={`news-badge-${p.id}`}>📰</span>
        )}
        {warn && (
          <span className="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-amber-400 text-[11px] font-black text-amber-950 shadow" title={p.warnings[0]}>
            !
          </span>
        )}
      </span>
      <span className="-mt-1.5 max-w-full truncate rounded-md bg-white px-1.5 py-0.5 text-[11px] font-extrabold text-fpl-purple shadow sm:text-xs">{p.name}</span>
      <span className="mt-0.5 flex w-full items-center justify-center gap-1 rounded-md bg-fpl-purple/90 px-1 py-0.5 text-[10px] font-bold text-white sm:text-[11px]">
        <span className="text-fpl-green">{p.ep.toFixed(1)}</span>
        <span className="opacity-70">·</span>
        <span>£{p.cost.toFixed(1)}</span>
      </span>
      <span className="mt-0.5 text-[10px] font-semibold text-white/90 drop-shadow sm:text-[11px]">
        {bench ? <span className="mr-1 rounded bg-black/30 px-1">{bench}</span> : null}
        {next ? `${next.oppShort} ${next.home ? "H" : "A"}` : "—"}
      </span>
    </button>
  );
}
