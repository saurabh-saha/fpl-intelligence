import type { PlayerView, SquadView } from "./client";
import type { ChipAdvice } from "./season/chips";
import type { ChipStatus } from "./season/rules";
import type { TransferAnalysis } from "./season/transfers";
import type { Holding } from "./season/types";

export interface EvalResp {
  gw: number;
  rollErrors: string[];
  base: { gw: number; holdings: Holding[]; bankTenths: number; freeTransfers: number; valueTenths: number; marketValueTenths: number; totalBudgetTenths: number; chips: ChipStatus[]; expectedPoints: number };
  plan: {
    valid: boolean;
    errors: string[];
    chip: string | null;
    transfers: { out: number; in: number; sellTenths: number; buyTenths: number; priceDiffTenths: number }[];
    count: number;
    hits: number;
    hitCost: number;
    freeUsed: number;
    ftAfter: number;
    bankTenths: number;
    permanentIds: number[];
    freeHitIds: number[] | null;
    valueTenths: number;
  };
  proposed: SquadView & { netExpectedPoints: number; deltaVsBase: number };
  players: Record<number, PlayerView>;
  fetchedAt: string;
  source: string;
  stale: boolean;
}

export type TransfersResp = TransferAnalysis & { players: Record<number, PlayerView> };
export interface ChipsResp {
  gw: number;
  bestNormalNet: number;
  advice: ChipAdvice[];
}
