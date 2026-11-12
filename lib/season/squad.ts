import type { Dataset, Player } from "../fpl/types";
import { validateSquad } from "../optimizer/validation";
import { chipErrors, nextFreeTransfers, sellingPrice, transferCost } from "./rules";
import type { GwPlan, Holding, PlannedTransfer, SeasonSquad, SeasonState, TransferRecord } from "./types";

export const byIdMap = (ds: Dataset) => new Map(ds.players.map((p) => [p.id, p]));

export function holdingSellTenths(h: Holding, p: Player, ds: Dataset): number {
  return sellingPrice(h.buyTenths, p.costTenths, ds.rules.sellOnFee);
}

/** Squad value as FPL counts it: selling prices of the 15 (bank excluded). */
export function squadValueTenths(squad: Pick<SeasonSquad, "holdings">, ds: Dataset): number {
  const by = byIdMap(ds);
  return squad.holdings.reduce((s, h) => s + (by.get(h.id) ? holdingSellTenths(h, by.get(h.id)!, ds) : h.buyTenths), 0);
}

/** Everything the manager can spend on a full rebuild (Wildcard / Free Hit): selling prices + bank. */
export const totalBudgetTenths = (squad: SeasonSquad, ds: Dataset) => squadValueTenths(squad, ds) + squad.bankTenths;

export interface PlanResult {
  valid: boolean;
  errors: string[];
  /** permanent squad after the plan (Free Hit squad is NOT included here) */
  holdings: Holding[];
  bankTenths: number;
  transfers: (TransferRecord & { sellTenths: number; priceDiffTenths: number })[];
  count: number;
  hits: number;
  hitCost: number;
  freeUsed: number;
  /** free transfers entering the following gameweek */
  ftAfter: number;
  chip: GwPlan["chip"];
  /** squad that actually plays the gameweek: permanent squad, or the temporary Free Hit squad */
  playingIds: number[];
  freeHitBudgetTenths?: number;
}

/**
 * Apply a plan to the actual squad. Pure and deterministic: all legality checks live here
 * (squad composition, club limit, bank >= 0, selling prices, free transfers, chips).
 * The actual squad passed in is never modified.
 */
export function applyPlan(actual: SeasonSquad, plan: GwPlan | undefined, ds: Dataset, gw = actual.gw): PlanResult {
  const p: GwPlan = plan ?? { transfers: [] };
  const by = byIdMap(ds);
  const errors: string[] = [];
  const chip = p.chip ?? null;
  errors.push(...chipErrors(ds, actual.chipsUsed, gw, chip));

  let holdings = actual.holdings.map((h) => ({ ...h }));
  let bank = actual.bankTenths;
  const records: PlanResult["transfers"] = [];

  for (const t of p.transfers) {
    const hi = holdings.findIndex((h) => h.id === t.out);
    const outP = by.get(t.out);
    const inP = by.get(t.in);
    if (hi < 0 || !outP) {
      errors.push(`Player ${t.out} is not in your squad.`);
      continue;
    }
    if (!inP) {
      errors.push(`Unknown player ${t.in}.`);
      continue;
    }
    if (holdings.some((h) => h.id === t.in)) {
      errors.push(`${inP.webName} is already in your squad.`);
      continue;
    }
    if (inP.status === "u" || inP.status === "n") errors.push(`${inP.webName} cannot be selected (status ${inP.status}).`);
    const sell = holdingSellTenths(holdings[hi], outP, ds);
    bank += sell - inP.costTenths;
    records.push({ out: t.out, in: t.in, outSellTenths: sell, sellTenths: sell, inBuyTenths: inP.costTenths, priceDiffTenths: inP.costTenths - sell });
    holdings = holdings.filter((h) => h.id !== t.out);
    holdings.push({ id: t.in, buyTenths: inP.costTenths });
  }

  const ids = holdings.map((h) => h.id);
  const v = validateSquad(ids, by, ds.rules, Number.MAX_SAFE_INTEGER);
  errors.push(...v.errors);
  if (bank < 0) errors.push(`Not enough money: £${(-bank / 10).toFixed(1)}m short.`);

  const { hits, cost, freeUsed } = transferCost(records.length, actual.freeTransfers, chip, ds.rules);
  const ftAfter = nextFreeTransfers(actual.freeTransfers, records.length, chip, ds.rules);

  let playingIds = ids;
  let freeHitBudgetTenths: number | undefined;
  if (chip === "freehit") {
    if (records.length > 0) errors.push("Under a Free Hit, plan the temporary squad instead of permanent transfers.");
    const fh = p.freeHitIds ?? ids;
    freeHitBudgetTenths = totalBudgetTenths(actual, ds);
    const fv = validateSquad(fh, by, ds.rules, freeHitBudgetTenths);
    errors.push(...fv.errors.map((e) => `Free Hit squad: ${e}`));
    if (fh.some((id) => by.get(id)?.status === "u" || by.get(id)?.status === "n")) errors.push("Free Hit squad contains an unselectable player.");
    playingIds = fh;
  } else if (p.freeHitIds) {
    errors.push("A Free Hit squad exists but the Free Hit chip is not selected.");
  }

  return { valid: errors.length === 0, errors, holdings, bankTenths: bank, transfers: records, count: records.length, hits, hitCost: cost, freeUsed, ftAfter, chip, playingIds, freeHitBudgetTenths };
}

/**
 * Carry the squad forward to `target`, applying the accepted plan of each intermediate gameweek.
 * Returns the BASE squad for `target` (the actual squad is untouched). Stops with errors on an illegal plan.
 */
export function rollForward(state: SeasonState, ds: Dataset, target: number): { base: SeasonSquad; errors: string[] } {
  let cur: SeasonSquad = { ...state.actual, holdings: state.actual.holdings.map((h) => ({ ...h })), chipsUsed: [...state.actual.chipsUsed] };
  for (let g = state.actual.gw; g < target; g++) {
    const plan = state.plans[g];
    const r = applyPlan(cur, plan, ds, g);
    if (!r.valid) return { base: cur, errors: r.errors.map((e) => `GW${g} plan: ${e}`) };
    cur = {
      gw: g + 1,
      holdings: r.holdings,
      bankTenths: r.bankTenths,
      freeTransfers: r.ftAfter,
      chipsUsed: plan?.chip ? [...cur.chipsUsed, { name: plan.chip, event: g }] : cur.chipsUsed,
      captain: cur.captain,
      vice: cur.vice,
    };
  }
  return { base: cur, errors: [] };
}

/**
 * Replace player `outId` with `inId` in the plan. If `outId` was bought earlier in this plan the
 * original transfer is rewritten (so one slot never costs two transfers); undoing a transfer removes it.
 */
export function editPlan(plan: GwPlan | undefined, baseIds: number[], outId: number, inId: number): GwPlan {
  const transfers: PlannedTransfer[] = [...(plan?.transfers ?? [])];
  const idx = transfers.findIndex((t) => t.in === outId);
  if (idx >= 0) {
    if (transfers[idx].out === inId) transfers.splice(idx, 1);
    else transfers[idx] = { out: transfers[idx].out, in: inId };
  } else if (baseIds.includes(outId)) {
    transfers.push({ out: outId, in: inId });
  } else {
    throw new Error("Player is not part of the squad.");
  }
  return { ...plan, transfers };
}
