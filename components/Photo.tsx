"use client";
import { useState } from "react";
import type { Pos } from "@/lib/fpl/types";

const BG: Record<Pos, string> = { GKP: "#ebff00", DEF: "#00ff87", MID: "#04f5ff", FWD: "#ff2882" };

/** Player headshot with a graceful initials fallback. */
export function Photo({ src, name, pos, size = 56 }: { src: string; name: string; pos: Pos; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className="relative inline-block shrink-0 overflow-hidden rounded-full border-2 border-white/90 shadow"
      style={{ width: size, height: size, background: BG[pos] }}
    >
      {!broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : (
        <span className="grid h-full w-full place-items-center text-xs font-extrabold text-fpl-purple">{name.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
