import { getDataset } from "@/lib/fpl/client";
import { fail, HttpError, parseGw, parsePrefs, readJson } from "@/lib/api";
import { projectAll } from "@/lib/analytics/playerScoring";
import { findAlternatives } from "@/lib/optimizer/alternatives";
import { lineupExpectedPoints } from "@/lib/optimizer/formationOptimizer";
import { validateLineup, validateSquad } from "@/lib/optimizer/validation";
import { buildReport, type ReportInput } from "@/lib/report/build";
import { renderReportPdf } from "@/lib/report/pdf";
import { chipStrategy } from "@/lib/season/chips";
import { sellingPrice } from "@/lib/season/rules";
import { analyseTransfers } from "@/lib/season/transfers";
import { evaluateSeason, horizon, seasonContext } from "@/lib/seasonApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ids = (raw: unknown, n: number, what: string): number[] => {
  if (!Array.isArray(raw) || raw.length !== n || raw.some((x) => !Number.isInteger(x))) throw new HttpError(400, `${what} must be ${n} player ids.`);
  return raw as number[];
};

/**
 * POST /api/report: Gameweek Intelligence Report (PDF).
 *
 * The client sends the squad EXACTLY as displayed (starting XI, bench, captain, vice). The server never
 * regenerates a squad: it validates what it was given (squad rules and lineup rules) and reports on it.
 * For My Team it re-evaluates the supplied season state with the same engine the screen uses and returns
 * 409 if the displayed squad no longer matches (stale screen), so a PDF can never describe a different squad.
 *
 * Body (builder):  { kind: "builder", gw, mode?, budget?, starting[11], bench[4], captain, vice, originalIds?[15] }
 * Body (my-team):  { kind: "my-team", season: { actual, plans }, gw, starting[11], bench[4], captain, vice, teamName?, ftDerived? }
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const starting = ids(body.starting, 11, "starting");
    const bench = ids(body.bench, 4, "bench");
    let input: ReportInput;

    if (body.kind === "my-team") {
      const ctx = await seasonContext(body);
      if (ctx.rollErrors.length) throw new HttpError(422, ctx.rollErrors.join(" "));
      const ev = evaluateSeason(ctx);
      const evStart = ev.proposed.starting.map((p) => p.id);
      const evBench = ev.proposed.bench.map((p) => p.id);
      if (JSON.stringify(evStart) !== JSON.stringify(starting) || JSON.stringify(evBench) !== JSON.stringify(bench) || ev.proposed.captain !== body.captain || ev.proposed.viceCaptain !== body.vice) {
        throw new HttpError(409, "The squad on screen no longer matches the current plan. Refresh the page and try again.");
      }
      const { ds, gw, hz, base } = ctx;
      const by = new Map(ds.players.map((p) => [p.id, p]));
      const transfers = analyseTransfers(ds, base, gw, hz);
      const bestNet = Math.max(0, ...transfers.options.map((o) => o.net));
      const holdings = new Map(base.holdings.map((h) => [h.id, { buyTenths: h.buyTenths, sellTenths: sellingPrice(h.buyTenths, by.get(h.id)!.costTenths, ds.rules.sellOnFee) }]));
      input = {
        kind: "my-team", ds, gw, hz, display: ctx.hz.display,
        starting, bench, captain: body.captain, vice: body.vice, formation: ev.proposed.formation, mode: "balanced",
        teamName: typeof body.teamName === "string" ? body.teamName.slice(0, 80) : undefined,
        totalCostM: ev.proposed.totalCost, projectedPoints: ev.proposed.expectedPoints,
        season: {
          actualIds: base.holdings.map((h) => h.id), holdings, bankTenths: ev.plan.bankTenths, freeTransfers: base.freeTransfers,
          freeTransfersDerived: !!body.ftDerived, chipPlanned: ev.plan.chip ?? null, chipsAvailable: ev.base.chips.filter((c) => c.available).map((c) => c.name),
          plan: { transfers: ev.plan.transfers.map((t) => ({ out: t.out, in: t.in, sellTenths: t.sellTenths, buyTenths: t.buyTenths })), hitCost: ev.plan.hitCost, hits: ev.plan.hits, ftAfter: ev.plan.ftAfter, valid: ev.plan.valid, errors: ev.plan.errors },
          transfers, chipAdvice: chipStrategy(ds, base, gw, bestNet, hz),
          baseExpectedPoints: ev.base.expectedPoints, projectedNet: ev.proposed.netExpectedPoints, projectedPoints: ev.proposed.expectedPoints,
        },
      };
    } else if (body.kind === "builder") {
      const ds = await getDataset();
      const gw = parseGw(body.gw, ds);
      const prefs = parsePrefs(body, ds);
      const by = new Map(ds.players.map((p) => [p.id, p]));
      const all = [...starting, ...bench];
      const budget = prefs.budgetTenths ?? ds.rules.budgetTenths;
      const sv = validateSquad(all, by, ds.rules, budget);
      if (!sv.valid) throw new HttpError(422, `Squad is not legal: ${sv.errors.join(" ")}`);
      const lineup = { starting, bench, formation: "", captain: body.captain, viceCaptain: body.vice };
      const cnt = (pos: string) => starting.filter((id) => by.get(id)!.pos === pos).length;
      lineup.formation = `${cnt("DEF")}-${cnt("MID")}-${cnt("FWD")}`;
      const lv = validateLineup(lineup, all, by, ds.rules);
      if (!lv.valid) throw new HttpError(422, `Lineup is not legal: ${lv.errors.join(" ")}`);
      const { byId: proj } = projectAll(ds, gw, prefs);
      const hz = horizon(ds, gw);
      const shortlist: NonNullable<ReportInput["shortlist"]> = {};
      for (const id of all) {
        const r = findAlternatives(ds, proj, all, id, prefs, 3);
        shortlist[id] = r.alternatives.map((a) => ({ id: a.playerId, ep: a.ep, costM: by.get(a.playerId)!.cost, deltaEp: a.deltaEp }));
      }
      const total = all.reduce((s, id) => s + by.get(id)!.costTenths, 0);
      input = {
        kind: "builder", ds, gw, hz, display: proj, starting, bench, captain: body.captain, vice: body.vice, formation: lineup.formation, mode: prefs.mode,
        originalIds: Array.isArray(body.originalIds) ? body.originalIds.filter(Number.isInteger) : undefined,
        shortlist, totalCostM: total / 10, remainingM: (budget - total) / 10,
        projectedPoints: lineupExpectedPoints({ ...lineup, viceCaptain: body.vice }, proj),
      };
    } else {
      throw new HttpError(400, 'kind must be "builder" or "my-team".');
    }

    const report = await buildReport(input);
    const pdf = await renderReportPdf(report);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="fpl-gw${input.gw}-${input.kind}-report.pdf"`,
        "x-report-squad": [...starting, ...bench].join(","),
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
