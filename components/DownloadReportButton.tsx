"use client";
import { useState } from "react";
import { downloadGwReport } from "@/lib/client";

/** One shared button for Team Builder and My Team. `buildBody` returns the exact on-screen squad, or null if not ready. */
export function DownloadReportButton({ buildBody, gw }: { buildBody: () => object | null; gw: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function go() {
    const body = buildBody();
    if (!body) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await downloadGwReport(body);
      setMsg({ ok: true, text: `Downloaded ${r.filename} (${Math.round(r.bytes / 1024)} KB)` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button onClick={go} disabled={busy} data-testid="download-report" className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-fpl-purple bg-white py-2 text-sm font-extrabold text-fpl-purple hover:bg-fpl-purple hover:text-white disabled:opacity-60">
        {busy ? <span className="spinner" style={{ borderColor: "rgba(55,0,60,.3)", borderTopColor: "#37003c" }} /> : <span aria-hidden>⬇</span>}
        Download GW{gw} report (PDF)
      </button>
      <p className="mt-1 text-[11px] text-slate-500">Includes all 15 players, XI, bench, captains, stats, xPts breakdown, fixtures, recommendations and machine-readable data for an independent review (e.g. upload to ChatGPT).</p>
      {msg && <p role={msg.ok ? "status" : "alert"} data-testid="report-msg" className={`mt-1 text-xs font-semibold ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
