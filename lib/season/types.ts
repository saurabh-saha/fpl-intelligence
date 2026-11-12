import type { ChipName } from "../fpl/types";
export type { ChipName };

export const CHIP_LABEL: Record<ChipName, string> = {
  wildcard: "Wildcard",
  freehit: "Free Hit",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
};

/** A squad member with the price paid, needed for selling prices. Prices are tenths of £m. */
export interface Holding {
  id: number;
  buyTenths: number;
}

export interface ChipUse {
  name: ChipName;
  event: number;
}

/** ACTUAL squad as it stands going into gameweek `gw` (before any plan for that gameweek). */
export interface SeasonSquad {
  gw: number;
  holdings: Holding[];
  bankTenths: number;
  /** free transfers available for `gw` */
  freeTransfers: number;
  chipsUsed: ChipUse[];
  captain?: number;
  vice?: number;
}

export interface PlannedTransfer {
  out: number;
  in: number;
}

/** PROPOSED changes for one gameweek. Never mutates the actual squad. */
export interface GwPlan {
  transfers: PlannedTransfer[];
  chip?: ChipName | null;
  /** TEMPORARY Free Hit squad (15 player ids). Dropped after the gameweek. */
  freeHitIds?: number[];
}

export interface TransferRecord {
  out: number;
  in: number;
  outSellTenths: number;
  inBuyTenths: number;
}

export interface Snapshot {
  gw: number;
  squadIds: number[];
  captain: number;
  vice: number;
  chip?: ChipName | null;
  transfers: TransferRecord[];
  hitCost: number;
  /** model projection made BEFORE the deadline (never back-filled) */
  predictedEp: number;
  /** real FPL points; filled from the FPL API or entered manually */
  actualPoints?: number;
  lockedAt: string;
}

export interface RecEntry {
  gw: number;
  at: string;
  label: string;
  transfers: { out: number; in: number; net: number }[];
  net: number;
  predictedEp: number;
  decision: "pending" | "accepted" | "rejected";
}

export interface SeasonState {
  version: 1;
  source: "import" | "generated" | "manual";
  teamId?: number;
  teamName?: string;
  actual: SeasonSquad;
  plans: Record<number, GwPlan>;
  snapshots: Snapshot[];
  recs: RecEntry[];
  /** real per-gameweek results imported from FPL */
  actualHistory: { event: number; points: number; transferCost: number; totalPoints: number; value: number; bank: number; chip?: string | null }[];
  warnings: string[];
  updatedAt: string;
}
