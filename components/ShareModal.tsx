"use client";
import { useMemo, useState } from "react";
import { encodeShare } from "@/lib/share";
import type { SquadView } from "@/lib/client";

export function ShareModal({ squad, gw, name, mode, onClose }: { squad: SquadView; gw: number; name?: string; mode: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const d = useMemo(() => encodeShare({ gw, ids: squad.squadIds, captain: squad.captain, vice: squad.viceCaptain, name, mode }), [squad, gw, name, mode]);
  const url = typeof window !== "undefined" ? `${window.location.origin}/share?d=${d}` : "";
  const img = `/api/share-image?d=${d}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" data-testid="share-modal">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close" />
      <div className="card relative w-full max-w-2xl space-y-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-fpl-purple">Share this squad</h2>
          <button onClick={onClose} className="rounded-full bg-fpl-bg px-3 py-1 text-sm font-bold">✕</button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img} alt="Squad graphic" className="w-full rounded-xl border bg-fpl-purple/10" />
        <div className="flex gap-2">
          <input readOnly value={url} className="min-w-0 flex-1 rounded-lg border bg-fpl-bg px-3 py-2 text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="share-url" />
          <button onClick={copy} className="rounded-lg bg-fpl-purple px-4 py-2 text-sm font-bold text-white" data-testid="copy-link">{copied ? "Copied ✓" : "Copy link"}</button>
        </div>
        <a href={img} download={`fpl-gw${gw}-squad.png`} className="inline-block text-sm font-bold text-fpl-purple underline">Download image</a>
      </div>
    </div>
  );
}
