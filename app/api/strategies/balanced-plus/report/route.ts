import { getDataset } from "@/lib/fpl/client";
import { fail, parseGw } from "@/lib/api";
import { horizon } from "@/lib/seasonApi";
import { buildBalancedPlusDoc } from "@/lib/strategies/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/strategies/balanced-plus/report?gw=11: Gameweek Intelligence Report (PDF) for Balanced Plus with the comparison appendix. */
export async function GET(req: Request) {
  try {
    const ds = await getDataset();
    const gw = parseGw(new URL(req.url).searchParams.get("gw"), ds);
    const doc = await buildBalancedPlusDoc(ds, gw, horizon(ds, gw));
    const pdf = await doc.pdf();
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="fpl-gw${gw}-balanced-plus-report.pdf"`,
        "x-report-squad": doc.bp.squad.join(","),
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
