"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import type { SeasonState } from "@/lib/season/types";

export function Onboarding({ onState, nextGw }: { onState: (s: SeasonState, notes?: string[]) => void; nextGw: number }) {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState<"import" | "gen" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doImport() {
    setBusy("import");
    setErr(null);
    try {
      const r = await api<{ state: SeasonState; derived: string[] }>(`/api/import/${id.trim()}`);
      onState(r.state, r.derived);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function generate() {
    setBusy("gen");
    setErr(null);
    try {
      const r = await api<{ squadIds: number[]; starting: any[]; bench: any[]; remaining: number; captain: number; viceCaptain: number }>("/api/optimize", { gw: nextGw, mode: "balanced" });
      const all = [...r.starting, ...r.bench];
      const state: SeasonState = {
        version: 1, source: "generated",
        actual: { gw: nextGw, holdings: all.map((p) => ({ id: p.id, buyTenths: p.costTenths })), bankTenths: Math.round(r.remaining * 10), freeTransfers: 1, chipsUsed: [], captain: r.captain, vice: r.viceCaptain },
        plans: {}, snapshots: [], recs: [], actualHistory: [],
        warnings: ["Started from the recommended squad. Bank, free transfers and chips are defaults: adjust them under Team settings to match your real team."],
        updatedAt: new Date().toISOString(),
      };
      onState(state);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="onboarding">
      <div className="card bg-gradient-to-r from-fpl-purple to-fpl-purple-2 p-6 text-white">
        <h1 className="text-3xl font-black">Season Manager</h1>
        <p className="mt-1 text-white/80">Carry your real FPL squad from gameweek to gameweek. Get transfer advice, know when to save, plan chips, and track predicted vs actual points.</p>
      </div>
      <div className="card space-y-3 p-5">
        <h2 className="font-extrabold text-fpl-purple">Import your FPL team</h2>
        <p className="text-sm text-slate-600">Enter your team ID (the number in the URL of your FPL <i>Points</i> page: fantasy.premierleague.com/entry/<b>123456</b>/event/…). Only public data is read. <b>We never ask for your FPL password.</b></p>
        <div className="flex gap-2">
          <input value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ""))} placeholder="Team ID, e.g. 1234567" inputMode="numeric" className="min-w-0 flex-1 rounded-xl border px-3 py-2" data-testid="team-id" onKeyDown={(e) => e.key === "Enter" && id && doImport()} />
          <button onClick={doImport} disabled={!id || !!busy} className="flex items-center gap-2 rounded-xl bg-fpl-purple px-4 py-2 text-sm font-extrabold text-white disabled:opacity-50" data-testid="import-btn">{busy === "import" && <span className="spinner" />}Import</button>
        </div>
        <p className="text-xs text-slate-500">Imported: squad, team value, bank, transfer history, captain, chips. Free transfers are <b>derived</b> from your history (FPL does not expose them) and can be overridden.</p>
      </div>
      <div className="card space-y-3 p-5">
        <h2 className="font-extrabold text-fpl-purple">No team ID? Start manually</h2>
        <p className="text-sm text-slate-600">Start from the recommended GW{nextGw} squad, then set your bank, free transfers and used chips under Team settings.</p>
        <button onClick={generate} disabled={!!busy} className="flex items-center gap-2 rounded-xl bg-fpl-green px-4 py-2 text-sm font-extrabold text-fpl-purple disabled:opacity-50" data-testid="start-generated">{busy === "gen" && <span className="spinner" />}Start from recommended squad</button>
      </div>
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700" role="alert" data-testid="import-error">{err}</div>}
    </div>
  );
}
