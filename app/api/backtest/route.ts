import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/backtest — latest backtest summary written by `npm run backtest` (404 if never run). */
export async function GET() {
  try {
    const txt = await fs.readFile(path.join(process.cwd(), "docs", "backtest-results.json"), "utf8");
    return NextResponse.json(JSON.parse(txt));
  } catch {
    return NextResponse.json({ error: "No backtest results yet. Run `npm run backtest`." }, { status: 404 });
  }
}
