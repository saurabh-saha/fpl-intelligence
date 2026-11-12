import { promises as fs } from "node:fs";
import path from "node:path";
import type { Dataset, Player, Projection } from "../fpl/types";
import { HORIZON_WEIGHTS, type Horizon } from "../season/horizon";
import type { TransferAnalysis } from "../season/transfers";
import type { ChipAdvice } from "../season/chips";

export const REPORT_SCHEMA = "fpl-gw-report/1";

export type ReportKind = "builder" | "my-team";

export interface ReportInput {
  kind: ReportKind;
  ds: Dataset;
  gw: number;
  hz: Horizon;
  /** projections WITH explanations for the report gameweek */
  display: Map<number, Projection>;
  /** the squad exactly as currently shown to the user */
  starting: number[];
  bench: number[];
  captain: number;
  vice: number;
  formation: string;
  mode: string;
  teamName?: string;
  /** builder: squad as originally generated, to list user edits */
  originalIds?: number[];
  /** my-team */
  season?: {
    actualIds: number[];
    holdings: Map<number, { buyTenths: number; sellTenths: number }>;
    bankTenths: number;
    freeTransfers: number;
    freeTransfersDerived: boolean;
    chipPlanned: string | null;
    chipsAvailable: string[];
    plan: { transfers: { out: number; in: number; sellTenths: number; buyTenths: number }[]; hitCost: number; hits: number; ftAfter: number; valid: boolean; errors: string[] };
    transfers: TransferAnalysis | null;
    chipAdvice: ChipAdvice[] | null;
    baseExpectedPoints: number;
    projectedNet: number;
    projectedPoints: number;
  };
  /** builder: replacement shortlist per player */
  shortlist?: Record<number, { id: number; ep: number; costM: number; deltaEp: number }[]>;
  remainingM?: number;
  totalCostM: number;
  projectedPoints: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fx = (f: { oppShort: string; home: boolean; difficulty: number }) => `${f.oppShort}(${f.home ? "H" : "A"}) FDR${f.difficulty}`;

async function backtestSummary() {
  try {
    const j = JSON.parse(await fs.readFile(path.join(process.cwd(), "docs", "backtest-results.json"), "utf8"));
    return { gameweeks: `GW${j.gameweeks[0]}-GW${j.gameweeks[j.gameweeks.length - 1]}`, sample: j.sample, modelMae: j.model.mae, baselineMae: j.baseline.mae, modelBias: j.model.bias, captainAvgPoints: j.captain.modelAvgPoints, baselineCaptainAvgPoints: j.captain.baselineAvgPoints, caveat: "Small sample (6 gameweeks); availability news is not point-in-time in the backtest." };
  } catch {
    return null;
  }
}

/** Structured, machine-readable description of the exact squad on screen. Pure data, no layout. */
export async function buildReport(i: ReportInput) {
  const { ds, gw, hz, display } = i;
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const startSet = new Set(i.starting);

  const record = (id: number, role: "starting" | "bench", order: number) => {
    const p = by.get(id) as Player;
    const pr = display.get(id) as Projection;
    const h = i.season?.holdings.get(id);
    const upcoming = hz.gws.map((g, k) => {
      const pk = hz.proj[k].get(id)!;
      return { gw: g, xPts: pk.ep, fixtures: pk.fixtures.map(fx) };
    });
    return {
      id: p.id,
      name: p.webName,
      fullName: `${p.firstName} ${p.secondName}`.trim(),
      club: ds.teams[p.teamId]?.short,
      position: p.pos,
      role,
      slot: order + (role === "starting" ? 1 : 11),
      benchOrder: role === "bench" ? order : null,
      isCaptain: id === i.captain,
      isViceCaptain: id === i.vice,
      priceM: p.cost,
      ...(h ? { purchasePriceM: h.buyTenths / 10, sellingPriceM: h.sellTenths / 10 } : {}),
      ownershipPct: p.ownership,
      status: p.status,
      news: p.news || null,
      season: {
        minutes: p.minutes, starts: p.starts, goals: p.goals, assists: p.assists,
        xG: r2(p.xG), xA: r2(p.xA), xGI: r2(p.xGI), xGI_per90: r2(p.xGI90),
        cleanSheets: p.cleanSheets, saves: p.saves, bonus: p.bonus,
        defensiveContributionPer90: r2(p.defContrib90),
        totalPoints: p.totalPoints, pointsPerGame: p.ppg, form: p.form,
      },
      projection: {
        gw,
        xPts: pr.ep,
        confidence: pr.confidence,
        confidenceScore: pr.confidenceScore,
        startProbability: pr.startProb,
        availability: pr.availability,
        expectedMinutes: pr.expMinutes,
        fixtures: pr.fixtures.map((f) => ({ opponent: f.oppShort, home: f.home, fdr: f.difficulty, kickoff: f.kickoff })),
        breakdown: pr.components,
      },
      upcomingFiveGws: upcoming,
      whySelected: pr.reasons,
      warnings: pr.warnings,
    };
  };

  const starting = i.starting.map((id, k) => record(id, "starting", k));
  const bench = i.bench.map((id, k) => record(id, "bench", k + 1));
  const all = [...starting, ...bench];
  const conf = all.reduce((s, p) => s + p.projection.confidenceScore, 0) / all.length;
  const startersConf = starting.reduce((s, p) => s + p.projection.confidenceScore, 0) / starting.length;
  const counts = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  all.forEach((p) => counts[p.projection.confidence]++);

  const edits =
    i.originalIds && JSON.stringify([...i.originalIds].sort()) !== JSON.stringify([...i.starting, ...i.bench].sort())
      ? {
          removed: i.originalIds.filter((id) => !startSet.has(id) && !i.bench.includes(id)).map((id) => by.get(id)!.webName),
          added: [...i.starting, ...i.bench].filter((id) => !i.originalIds!.includes(id)).map((id) => by.get(id)!.webName),
        }
      : null;

  const s = i.season;
  const team = (id: number) => by.get(id)!.webName;
  const report = {
    schema: REPORT_SCHEMA,
    title: `Gameweek ${gw} Intelligence Report`,
    generatedAt: new Date().toISOString(),
    app: "FPL Intelligence",
    gameweek: { id: gw, name: ds.events.find((e) => e.id === gw)?.name, deadline: ds.events.find((e) => e.id === gw)?.deadline },
    squadSource: i.kind === "my-team" ? "My Team: PROPOSED squad (actual squad + accepted plan), exactly as shown in the app" : "Team Builder squad exactly as shown in the app (including any manual replacements)",
    team: i.teamName ?? null,
    optimisationMode: i.mode,
    dataFreshness: { fetchedAt: ds.fetchedAt, source: ds.source, stale: ds.stale },
    legend: "FACT = real FPL data (price, ownership, status, season stats, fixtures, FDR). MODEL = this app's prediction (xPts, confidence, start probability, expected minutes, breakdown, recommendations). Predictions are estimates, not guarantees.",
    squad: {
      formation: i.formation,
      captain: team(i.captain),
      viceCaptain: team(i.vice),
      captainId: i.captain,
      viceCaptainId: i.vice,
      startingXI: i.starting,
      bench: i.bench,
      totalCostM: i.totalCostM,
      bankM: i.kind === "my-team" ? (s!.bankTenths / 10) : (i.remainingM ?? null),
      projectedPoints: i.projectedPoints,
      projectedPointsNote: "Sum of starting XI expected points plus captain's extra points (captain x2; Bench Boost counts all 15; Triple Captain x3).",
      expectedPointsFromStartingXI: r2(lineupExpectedPointsFrom(starting)),
      modelConfidence: { overall: r2(conf), startingXI: r2(startersConf), counts },
    },
    players: all,
    userEditsVsGeneratedSquad: edits,
    season:
      i.kind === "my-team" && s
        ? {
            freeTransfersAvailable: s.freeTransfers,
            freeTransfersAreDerived: s.freeTransfersDerived,
            freeTransfersAfterPlan: s.plan.ftAfter,
            bankM: s.bankTenths / 10,
            chipPlannedThisGameweek: s.chipPlanned,
            chipsAvailable: s.chipsAvailable,
            actualSquad: {
              note: "ACTUAL squad going into this gameweek, before any proposed change",
              playerIds: s.actualIds,
              players: s.actualIds.map((id) => ({ id, name: team(id), club: ds.teams[by.get(id)!.teamId]?.short, position: by.get(id)!.pos, purchasePriceM: s.holdings.get(id)!.buyTenths / 10, sellingPriceM: s.holdings.get(id)!.sellTenths / 10 })),
              projectedPointsWithNoChanges: s.baseExpectedPoints,
            },
            proposedPlan: {
              valid: s.plan.valid,
              errors: s.plan.errors,
              transfers: s.plan.transfers.map((t) => ({ sell: team(t.out), sellPriceM: t.sellTenths / 10, buy: team(t.in), buyPriceM: t.buyTenths / 10, sellId: t.out, buyId: t.in })),
              hitCost: s.plan.hitCost,
              hits: s.plan.hits,
              projectedPoints: s.projectedPoints,
              projectedPointsAfterHit: s.projectedNet,
            },
          }
        : null,
    transferRecommendations:
      i.kind === "my-team" && s?.transfers
        ? {
            note: "Judged over the next five gameweeks with discount weights " + HORIZON_WEIGHTS.join("/") + "; net = discounted gain minus 4 per transfer beyond the free allowance; selling prices and bank respected.",
            decision: s.transfers.action,
            headline: s.transfers.headline,
            reason: s.transfers.reason,
            options: s.transfers.options.map((o) => ({ transfers: o.n, label: o.label, gainThisGw: o.gainGw, gainFiveGws: o.gainHorizon, hitCost: o.hitCost, net: o.net, freeTransfersAfter: o.ftAfter, moves: o.transfers.map((t) => ({ sell: team(t.out), buy: team(t.in), priceDiffM: t.priceDiffTenths / 10, gainThisGw: t.gainGw, gainFiveGws: t.gainHorizon, deduction: t.deduction, net: t.net, differential: t.differential, explanation: t.explanation })) })),
            recommendedTransfers: s.transfers.recommendedN,
            sellShortlist: s.transfers.sellCandidates.slice(0, 6).map((c) => ({ sell: team(c.out), sellPriceM: c.sellTenths / 10, reason: c.reason, alternatives: c.alternatives.slice(0, 3).map((a) => ({ buy: team(a.in), priceDiffM: a.priceDiffTenths / 10, netFiveGws: a.net })) })),
          }
        : i.kind === "builder"
          ? {
              note: "Team Builder generates a new squad, so there are no transfers to recommend. Below: the best legal replacements for each player within budget, by expected points.",
              replacementShortlist: Object.fromEntries(Object.entries(i.shortlist ?? {}).map(([id, alts]) => [team(Number(id)), alts.map((a) => ({ player: team(a.id), xPts: a.ep, priceM: a.costM, squadPointsChange: a.deltaEp }))])),
            }
          : null,
    chipStrategy: i.kind === "my-team" && s?.chipAdvice ? s.chipAdvice.map((c) => ({ chip: c.label, available: c.available, verdict: c.verdict, advice: c.text, gainNow: c.nowGain, bestGameweek: c.best })) : null,
    model: {
      description: "Deterministic expected-points model built from FPL's scoring table: appearance + goals + assists + clean sheet + goals conceded + saves + defensive contribution + bonus + cards, with a bounded form tilt. Goal/assist rates blend 0.8*xG/xA + 0.2*actual, shrunk to the positional average by minutes (reliability = minutes/(minutes+450)). Fixture strength uses opponents' goals and xG for/against with home advantage. Squads come from an integer-linear-programming optimiser (not an LLM).",
      confidence: "confidenceScore = 0.45*sample size + 0.25*availability certainty + 0.30*start probability; high >= 0.7, medium >= 0.45, else low.",
      backtest: await backtestSummary(),
      limitations: [
        "xPts are estimates; the model has no access to team news beyond FPL's status/news fields.",
        "No shots-on-target or box-touch data; opponent xGC is derived from the first-choice goalkeeper.",
        "Future prices are not predicted; selling prices use today's prices.",
        "Small backtest sample; weights are heuristics, not fitted.",
      ],
    },
    reviewerGuide: [
      "Check the captain/vice choice against fixtures and minutes security.",
      "Check each starter's start probability and any warnings, especially flagged players.",
      "Sanity-check xPts breakdowns (appearance, goals, assists, clean sheet, bonus) for implausible values.",
      "Challenge the transfer decision (save vs move vs hit) and the chip verdicts using the next-five-gameweek fixtures.",
      "Look for club-concentration, bench-quality and budget-use issues.",
    ],
  };
  return report;

  function lineupExpectedPointsFrom(st: { projection: { xPts: number } }[]) {
    return st.reduce((a, p) => a + p.projection.xPts, 0);
  }
}

export type GwReport = Awaited<ReturnType<typeof buildReport>>;
