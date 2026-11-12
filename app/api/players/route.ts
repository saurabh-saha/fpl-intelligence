import { NextResponse } from "next/server";
import { context, fail, freshness, view } from "@/lib/api";
import type { Pos } from "@/lib/fpl/types";

export const dynamic = "force-dynamic";

const SORTS: Record<string, (v: ReturnType<typeof view>) => number> = {
  ep: (v) => v.ep,
  goals: (v) => v.goals,
  assists: (v) => v.assists,
  xG: (v) => v.xG,
  xA: (v) => v.xA,
  minutes: (v) => v.minutes,
  form: (v) => v.form,
  cost: (v) => v.cost,
  ownership: (v) => v.ownership,
  totalPoints: (v) => v.totalPoints,
};

/** GET /api/players?gw=&q=&pos=&team=&sort=ep&dir=desc&limit=100&offset=0&ids=1,2,3 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const { ds, gw, proj } = await context(sp.get("gw"), { mode: sp.get("mode") ?? "balanced" });
    const q = (sp.get("q") ?? "").trim().toLowerCase();
    const pos = sp.get("pos") as Pos | null;
    const team = sp.get("team") ? Number(sp.get("team")) : null;
    const ids = sp.get("ids") ? new Set(sp.get("ids")!.split(",").map(Number)) : null;
    const sort = SORTS[sp.get("sort") ?? "ep"] ?? SORTS.ep;
    const dir = sp.get("dir") === "asc" ? 1 : -1;
    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 100), 1), 800);
    const offset = Math.max(Number(sp.get("offset") ?? 0), 0);

    let rows = ds.players
      .filter((p) => (!ids || ids.has(p.id)) && (!pos || p.pos === pos) && (!team || p.teamId === team))
      .filter((p) => !q || `${p.webName} ${p.firstName} ${p.secondName}`.toLowerCase().includes(q))
      .map((p) => view(p, proj.get(p.id)!, ds));
    rows.sort((a, b) => dir * (sort(a) - sort(b)) || a.id - b.id);
    const total = rows.length;
    rows = rows.slice(offset, offset + limit);
    return NextResponse.json({ gw, total, players: rows, ...freshness(ds) });
  } catch (e) {
    return fail(e);
  }
}
