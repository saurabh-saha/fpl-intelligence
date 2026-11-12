"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, type PlayerView, type SquadView } from "@/lib/client";
import { decodeShare } from "@/lib/share";
import { FootballPitch } from "@/components/FootballPitch";
import { BudgetSummary } from "@/components/BudgetSummary";
import { PlayerPanel } from "@/components/AlternativeSelector";

/** Read-only view of a shared squad: no login required. Projections are recomputed from live FPL data. */
export function ShareView() {
  const d = useSearchParams().get("d") ?? "";
  const payload = decodeShare(d);
  const [squad, setSquad] = useState<SquadView | null>(null);
  const [err, setErr] = useState<string | null>(payload ? null : "This share link is invalid or incomplete.");
  const [sel, setSel] = useState<PlayerView | null>(null);

  useEffect(() => {
    if (!payload) return;
    api<SquadView>("/api/evaluate", { gw: payload.gw, squad: payload.ids, mode: payload.mode }).then(setSquad).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  if (err) return <div className="card p-6 text-rose-700" role="alert">{err}</div>;
  if (!squad || !payload) return <div className="p-10 text-center text-slate-500">Loading squad…</div>;
  return (
    <div className="space-y-4" data-testid="share-view">
      <div className="card bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-5 text-white">
        <div className="text-xs font-bold uppercase text-fpl-green">Shared squad · GW{payload.gw}</div>
        <h1 className="text-3xl font-black">{payload.name ?? `Gameweek ${payload.gw} recommendation`}</h1>
        <p className="mt-1 text-sm text-white/80">Captain {squad.starting.find((p) => p.id === squad.captain)?.name} · {squad.formation} · projected {squad.expectedPoints.toFixed(1)} pts</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <FootballPitch squad={squad} onSelect={setSel} />
        <div className="space-y-4">
          <BudgetSummary squad={squad} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/share-image?d=${d}`} alt="Squad graphic" className="w-full rounded-xl border" />
          <Link href={`/team-builder?gw=${payload.gw}`} className="block rounded-xl bg-fpl-green py-2.5 text-center text-sm font-extrabold text-fpl-purple">Build your own →</Link>
        </div>
      </div>
      {sel && <PlayerPanel player={squad.starting.concat(squad.bench).find((p) => p.id === sel.id) ?? sel} gw={payload.gw} squad={squad} prefs={{ mode: "balanced" }} isCaptain={squad.captain === sel.id} onClose={() => setSel(null)} onReplace={() => setSel(null)} />}
    </div>
  );
}
