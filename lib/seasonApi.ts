import { getDataset } from "./fpl/client";
import type { NewsOverlay } from "./news/overlay";
import { loadOverlay } from "./news/service";
import { HttpError, parseGw, parseSeason, view, squadView, type PlayerView } from "./api";
import { buildHorizon, type Horizon } from "./season/horizon";
import { applyPlan, byIdMap, rollForward, squadValueTenths, totalBudgetTenths } from "./season/squad";
import { chipExpectedPoints } from "./season/chips";
import { chipStatuses } from "./season/rules";
import { evaluateSquad } from "./optimizer/alternatives";
import type { Dataset, Projection } from "./fpl/types";
import type { SeasonSquad, SeasonState } from "./season/types";

const hzCache = new Map<string, Horizon>();
export function horizon(ds: Dataset, gw: number, news?: NewsOverlay | null): Horizon {
  const key = `${ds.fetchedAt}:${ds.source}:${gw}:${news?.version ?? "no-news"}`;
  let hz = hzCache.get(key);
  if (!hz) {
    hz = buildHorizon(ds, gw, undefined, news);
    hzCache.set(key, hz);
    if (hzCache.size > 8) hzCache.delete(hzCache.keys().next().value!);
  }
  return hz;
}

export interface SeasonCtx {
  ds: Dataset;
  state: SeasonState;
  gw: number;
  base: SeasonSquad;
  rollErrors: string[];
  hz: Horizon;
  news: NewsOverlay | null;
  /** gameweek projections with ep as the ranking score, for lineups */
  proj: Map<number, Projection>;
}

export async function seasonContext(body: any): Promise<SeasonCtx> {
  const ds = await getDataset();
  const state = parseSeason(body);
  const gw = body.gw === undefined || body.gw === null ? state.actual.gw : parseGw(body.gw, ds);
  if (gw < state.actual.gw) throw new HttpError(400, `Cannot plan GW${gw}: your actual squad is already at GW${state.actual.gw}.`);
  const { base, errors } = rollForward(state, ds, gw);
  const news = await loadOverlay({ disabled: body.news === false });
  const hz = horizon(ds, gw, news);
  const proj = new Map([...hz.display].map(([id, pr]) => [id, { ...pr, score: pr.ep }]));
  return { ds, state, gw, base, rollErrors: errors, hz, news, proj };
}

export function playersFor(ctx: SeasonCtx, ids: Iterable<number>): Record<number, PlayerView> {
  const by = byIdMap(ctx.ds);
  const out: Record<number, PlayerView> = {};
  for (const id of ids) {
    const p = by.get(id);
    if (p) out[id] = view(p, ctx.hz.display.get(id)!, ctx.ds);
  }
  return out;
}

/** BASE squad summary + PROPOSED squad (plan applied) for the pitch and summary cards. */
export function evaluateSeason(ctx: SeasonCtx) {
  const { ds, state, gw, base, proj } = ctx;
  const by = byIdMap(ds);
  const plan = state.plans[gw];
  const res = applyPlan(base, plan, ds, gw);
  const baseIds = base.holdings.map((h) => h.id);
  const evalIds = res.valid || res.playingIds.length === 15 ? res.playingIds : baseIds;
  const budget = totalBudgetTenths(base, ds);
  const baseResult = evaluateSquad(ds, proj, baseIds, { mode: "balanced", budgetTenths: budget, overCap: true });
  let proposed = baseResult;
  let usedBase = true;
  try {
    proposed = evaluateSquad(ds, proj, evalIds, { mode: "balanced", budgetTenths: res.chip === "freehit" ? (res.freeHitBudgetTenths ?? budget) : Math.max(budget, 0), overCap: true });
    usedBase = evalIds === baseIds;
  } catch {
    /* illegal composition: fall back to base for display, errors are returned */
  }
  const chipPlayers = proposed.squad.map((id) => by.get(id)!);
  const baseEp = baseResult.expectedPoints;
  const proposedEp = chipExpectedPoints(chipPlayers, proj, ds, res.chip);
  const hitCost = res.hitCost;
  const permanent = res.holdings.map((h) => h.id);
  const sv = squadView(ds, ctx.hz.display, proposed);
  // fix price-sensitive fields: remaining bank = money left after the plan (not the legacy 100m calc)
  return {
    gw,
    rollErrors: ctx.rollErrors,
    base: {
      gw: base.gw,
      holdings: base.holdings,
      bankTenths: base.bankTenths,
      freeTransfers: base.freeTransfers,
      valueTenths: squadValueTenths(base, ds),
      marketValueTenths: base.holdings.reduce((a, h) => a + (by.get(h.id)?.costTenths ?? h.buyTenths), 0),
      totalBudgetTenths: budget,
      chips: chipStatuses(ds, base.chipsUsed, gw),
      expectedPoints: baseEp,
    },
    plan: {
      valid: res.valid,
      errors: res.errors,
      chip: res.chip,
      transfers: res.transfers.map((t) => ({ out: t.out, in: t.in, sellTenths: t.sellTenths, buyTenths: t.inBuyTenths, priceDiffTenths: t.priceDiffTenths })),
      count: res.count,
      hits: res.hits,
      hitCost,
      freeUsed: res.freeUsed,
      ftAfter: res.ftAfter,
      bankTenths: res.bankTenths,
      permanentIds: permanent,
      freeHitIds: res.chip === "freehit" ? res.playingIds : null,
      valueTenths: squadValueTenths({ holdings: res.holdings }, ds),
    },
    proposed: {
      ...sv,
      remaining: (res.chip === "freehit" ? (res.freeHitBudgetTenths ?? 0) - proposed.totalCostTenths : res.bankTenths) / 10,
      expectedPoints: proposedEp,
      netExpectedPoints: Math.round((proposedEp - hitCost) * 100) / 100,
      deltaVsBase: Math.round((proposedEp - baseEp) * 100) / 100,
      usedBaseFallback: usedBase && !!plan?.transfers.length,
    },
    players: playersFor(ctx, [...baseIds, ...proposed.squad, ...res.transfers.flatMap((t) => [t.out, t.in])]),
  };
}
