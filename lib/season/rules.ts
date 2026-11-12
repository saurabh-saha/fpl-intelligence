import type { ChipName, Dataset, Rules } from "../fpl/types";
import type { ChipUse } from "./types";

/**
 * FPL selling price (tenths of £m): a loss is taken in full, a profit is shared
 * (manager keeps `fee` of it, rounded DOWN to the nearest 0.1m).
 */
export function sellingPrice(buyTenths: number, currentTenths: number, fee = 0.5): number {
  if (currentTenths <= buyTenths) return currentTenths;
  return buyTenths + Math.floor((currentTenths - buyTenths) * fee + 1e-9);
}

/** Free transfers for the following gameweek. Wildcard/Free Hit keep the bank (no new transfer accrued). */
export function nextFreeTransfers(ftBefore: number, transfersMade: number, chip: ChipName | null | undefined, rules: Pick<Rules, "freeTransfersPerGw" | "maxFreeTransfers">): number {
  if (chip === "wildcard" || chip === "freehit") return Math.min(ftBefore, rules.maxFreeTransfers);
  const left = Math.max(ftBefore - transfersMade, 0);
  return Math.min(rules.maxFreeTransfers, left + rules.freeTransfersPerGw);
}

/** Points deducted: 4 per transfer beyond the free allowance; none under Wildcard/Free Hit. */
export function transferCost(n: number, ft: number, chip: ChipName | null | undefined, rules: Pick<Rules, "transferHit">) {
  const unlimited = chip === "wildcard" || chip === "freehit";
  const hits = unlimited ? 0 : Math.max(0, n - ft);
  return { hits, cost: hits * rules.transferHit, freeUsed: unlimited ? 0 : Math.min(n, ft) };
}

export interface ChipStatus {
  name: ChipName;
  /** window currently relevant for `gw` */
  window: { start: number; stop: number } | null;
  usedInWindow: number;
  allowed: number;
  available: boolean;
  reason?: string;
}

/** Availability of each chip for `gw`, from the API's chip windows and the user's usage history. */
export function chipStatuses(ds: Pick<Dataset, "chips">, used: ChipUse[], gw: number): ChipStatus[] {
  const names: ChipName[] = ["wildcard", "freehit", "bboost", "3xc"];
  return names.map((name) => {
    const defs = ds.chips.filter((c) => c.name === name);
    const def = defs.find((c) => gw >= c.start && gw <= c.stop);
    if (!def) {
      const later = defs.find((c) => c.start > gw);
      return { name, window: null, usedInWindow: 0, allowed: 0, available: false, reason: later ? `Next set opens GW${later.start}` : "No chip window" };
    }
    const usedInWindow = used.filter((u) => u.name === name && u.event >= def.start && u.event <= def.stop).length;
    const available = usedInWindow < def.number;
    return {
      name,
      window: { start: def.start, stop: def.stop },
      usedInWindow,
      allowed: def.number,
      available,
      reason: available ? undefined : `Used in GW${used.find((u) => u.name === name && u.event >= def.start && u.event <= def.stop)?.event}`,
    };
  });
}

/** Deterministic chip legality for playing `chip` in `gw`. Returns error strings (empty = legal). */
export function chipErrors(ds: Pick<Dataset, "chips">, used: ChipUse[], gw: number, chip: ChipName | null | undefined): string[] {
  if (!chip) return [];
  const errors: string[] = [];
  if (used.some((u) => u.event === gw)) errors.push(`A chip was already played in GW${gw}: only one chip per gameweek.`);
  const status = chipStatuses(ds, used, gw).find((s) => s.name === chip)!;
  if (!status.window) errors.push(`${chip} is not available in GW${gw}. ${status.reason ?? ""}`.trim());
  else if (!status.available) errors.push(`${chip} already used in this half of the season (${status.reason}).`);
  if (chip === "freehit") {
    if (gw === 1) errors.push("Free Hit cannot be played in GW1.");
    if (used.some((u) => u.name === "freehit" && u.event === gw - 1)) errors.push("Free Hit cannot be played in consecutive gameweeks.");
  }
  return errors;
}
