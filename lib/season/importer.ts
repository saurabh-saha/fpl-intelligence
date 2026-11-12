import type { Rules } from "../fpl/types";
import type { ChipName } from "../fpl/types";
import { nextFreeTransfers } from "./rules";
import type { ChipUse, Holding } from "./types";

/** FPL's chip names as returned by /api/entry/{id}/history/ -> ours. */
export function chipFromFpl(name: string): ChipName | null {
  const map: Record<string, ChipName> = { wildcard: "wildcard", freehit: "freehit", bboost: "bboost", "3xc": "3xc" };
  return map[name] ?? null;
}

export interface RawTransfer {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  event: number;
  time: string;
}

/**
 * Rebuild the squad with purchase prices by replaying the transfer history on top of the opening squad.
 * Free Hit gameweeks are skipped: their transfers were temporary and the squad reverted afterwards.
 */
export function reconstructHoldings(initial: Holding[], transfers: RawTransfer[], freeHitEvents: Set<number>): Holding[] {
  const holdings = new Map(initial.map((h) => [h.id, h.buyTenths]));
  const ordered = [...transfers].sort((a, b) => a.time.localeCompare(b.time));
  for (const t of ordered) {
    if (freeHitEvents.has(t.event)) continue;
    holdings.delete(t.element_out);
    holdings.set(t.element_in, t.element_in_cost);
  }
  return [...holdings].map(([id, buyTenths]) => ({ id, buyTenths }));
}

/**
 * Free transfers entering gameweek `upTo + 1`, derived from the per-gameweek transfer counts and chips.
 * The FPL API does not expose this number directly, so it is DERIVED (and flagged as such in the UI).
 * Rule used: 1 free transfer enters the second gameweek, then +1 per gameweek, bank capped, unused ones roll
 * over, a hit resets to 1, and Wildcard/Free Hit leave the bank unchanged.
 */
export function simulateFreeTransfers(
  startedEvent: number,
  upTo: number,
  transfersByEvent: Record<number, number>,
  chips: ChipUse[],
  rules: Pick<Rules, "freeTransfersPerGw" | "maxFreeTransfers">,
): number {
  let ft = rules.freeTransfersPerGw;
  for (let g = startedEvent + 1; g <= upTo; g++) {
    const chip = chips.find((c) => c.event === g)?.name ?? null;
    ft = nextFreeTransfers(ft, transfersByEvent[g] ?? 0, chip, rules);
  }
  return ft;
}
