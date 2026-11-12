import { ImageResponse } from "next/og";
import { getDataset } from "@/lib/fpl/client";
import { projectAll } from "@/lib/analytics/playerScoring";
import { decodeShare } from "@/lib/share";
import { evaluateSquad } from "@/lib/optimizer/alternatives";

export const dynamic = "force-dynamic";

const POS_COLOR: Record<string, string> = { GKP: "#ebff00", DEF: "#00ff87", MID: "#05f0ff", FWD: "#ff005a" };

/** GET /api/share-image?d=<encoded squad> — 1200x630 PNG of the recommended squad for sharing. */
export async function GET(req: Request) {
  const d = new URL(req.url).searchParams.get("d") ?? "";
  const share = decodeShare(d);
  if (!share) return new Response("Invalid share payload", { status: 400 });
  const ds = await getDataset();
  const { byId: proj } = projectAll(ds, share.gw);
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  if (!share.ids.every((id) => byId.has(id))) return new Response("Unknown player in payload", { status: 400 });
  let result;
  try {
    result = evaluateSquad(ds, proj, share.ids, { mode: "balanced" });
  } catch {
    return new Response("Invalid squad", { status: 422 });
  }
  const rows = (["GKP", "DEF", "MID", "FWD"] as const).map((pos) => result.starting.filter((id) => byId.get(id)!.pos === pos));

  const chip = (id: number, small = false) => {
    const p = byId.get(id)!;
    const isC = id === share.captain;
    const isV = id === share.vice;
    return (
      <div key={id} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: small ? 104 : 150 }}>
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: small ? 36 : 58, height: small ? 36 : 58, borderRadius: 999,
            background: POS_COLOR[p.pos], color: "#37003c", fontWeight: 800, fontSize: small ? 16 : 20,
            border: isC ? "4px solid #fff" : "4px solid rgba(255,255,255,0.0)",
          }}
        >
          {isC ? "C" : isV ? "V" : p.pos[0]}
        </div>
        <div style={{ display: "flex", marginTop: 6, background: "#fff", color: "#37003c", borderRadius: 6, padding: "2px 8px", fontSize: small ? 14 : 20, fontWeight: 700 }}>
          {p.webName}
        </div>
        <div style={{ display: "flex", fontSize: small ? 12 : 16, color: "#e8d9ee", marginTop: 2 }}>
          {ds.teams[p.teamId]?.short} · £{p.cost.toFixed(1)}m · {proj.get(id)!.ep.toFixed(1)}
        </div>
      </div>
    );
  };

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: 1200, height: 630, background: "linear-gradient(135deg,#37003c,#5b0f63)", color: "#fff", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 780, padding: "28px 24px", justifyContent: "space-between", background: "linear-gradient(#0d8a4a,#0a7a41)" }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-around" }}>{r.map((id) => chip(id))}</div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: 24, justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", color: "#00ff87", fontSize: 22, fontWeight: 700 }}>FPL INTELLIGENCE</div>
            <div style={{ display: "flex", fontSize: 32, fontWeight: 800, marginTop: 6 }}>{share.name ?? `Gameweek ${share.gw} squad`}</div>
            <div style={{ display: "flex", fontSize: 22, marginTop: 6, color: "#e8d9ee" }}>GW{share.gw} · {result.formation}</div>
            <div style={{ display: "flex", flexDirection: "column", marginTop: 12 }}>
              <div style={{ display: "flex", fontSize: 18, color: "#e8d9ee" }}>Projected points</div>
              <div style={{ display: "flex", fontSize: 64, fontWeight: 800, color: "#00ff87" }}>{result.expectedPoints.toFixed(1)}</div>
              <div style={{ display: "flex", fontSize: 18, color: "#e8d9ee" }}>Captain: {byId.get(share.captain)!.webName} (x2)</div>
              <div style={{ display: "flex", fontSize: 18, color: "#e8d9ee" }}>Squad value £{(result.totalCostTenths / 10).toFixed(1)}m</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 16, color: "#e8d9ee", marginBottom: 6 }}>Bench</div>
            <div style={{ display: "flex", flexWrap: "wrap" }}>{result.bench.map((id) => chip(id, true))}</div>
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
