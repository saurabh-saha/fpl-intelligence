import { projectAll } from "../analytics/playerScoring";
import type { Dataset, Mode, Player } from "../fpl/types";
import { bestLineup, lineupExpectedPoints } from "../optimizer/formationOptimizer";
import { optimizeSquad } from "../optimizer/squadOptimizer";
import type { Horizon } from "../season/horizon";
import { BALANCED_PLUS, type BalancedPlusResult } from "./balancedPlus";

export type StrategyKey = "balanced" | "safe" | "aggressive" | "balanced-plus";
export const STRATEGY_LABEL: Record<StrategyKey, string> = { balanced: "Balanced", safe: "Safe", aggressive: "Aggressive", "balanced-plus": "Balanced Plus" };

export interface StrategySquad {
  key: StrategyKey;
  label: string;
  starting: number[];
  bench: number[];
  captain: number;
  vice: number;
  formation: string;
  totalCostTenths: number;
  remainingTenths: number;
}

/** The three existing strategies, produced by the UNCHANGED optimiser from the same dataset. */
export function existingStrategies(ds: Dataset, gw: number): StrategySquad[] {
  return (["balanced", "safe", "aggressive"] as Mode[]).map((mode) => {
    const { byId } = projectAll(ds, gw, { mode });
    const { result: r } = optimizeSquad(ds, byId, { mode });
    return { key: mode as StrategyKey, label: STRATEGY_LABEL[mode as StrategyKey], starting: r.starting, bench: r.bench, captain: r.captain, vice: r.viceCaptain, formation: r.formation, totalCostTenths: r.totalCostTenths, remainingTenths: r.remainingTenths };
  });
}

export function balancedPlusSquad(r: BalancedPlusResult): StrategySquad {
  return { key: "balanced-plus", label: STRATEGY_LABEL["balanced-plus"], starting: r.starting, bench: r.bench, captain: r.captain, vice: r.viceCaptain, formation: r.formation, totalCostTenths: r.totalCostTenths, remainingTenths: r.remainingTenths };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function strategyMetrics(ds: Dataset, hz: Horizon, s: StrategySquad) {
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const p0 = hz.proj[0];
  const players = [...s.starting, ...s.bench].map((id) => by.get(id) as Player);
  const xi = s.starting.map((id) => by.get(id) as Player);
  const bench = s.bench.map((id) => by.get(id) as Player);
  // GW0 is the lineup the strategy actually chose; later gameweeks use the best XI of the same 15 players for everyone
  const gw0 = r2(s.starting.reduce((a, id) => a + p0.get(id)!.ep, 0) + p0.get(s.captain)!.ep);
  const perGw = hz.proj.map((pm, k) => (k === 0 ? gw0 : r2(lineupExpectedPoints(bestLineup(players, pm, ds.rules), pm))));
  const discounted = r2(perGw.reduce((a, v, k) => a + v * hz.weights[k], 0));
  const clubs = new Map<number, number>();
  xi.forEach((p) => clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1));
  const maxClubXI = Math.max(...clubs.values());
  const clubsOver2 = [...clubs].filter(([, n]) => n > 2).map(([t, n]) => `${ds.teams[t].short} x${n}`);
  const below = xi.filter((p) => p0.get(p.id)!.startProb < BALANCED_PLUS.xiMinStartProb || p0.get(p.id)!.expMinutes < BALANCED_PLUS.xiMinExpMinutes);
  const outfield = xi.filter((p) => p.pos !== "GKP");
  const xgi = outfield.reduce((a, p) => a + p.xGI90, 0);
  const xa = outfield.reduce((a, p) => a + p.xA90, 0);
  const cap = by.get(s.captain)!;
  const vice = by.get(s.vice)!;
  return {
    key: s.key,
    label: s.label,
    formation: s.formation,
    costM: s.totalCostTenths / 10,
    bankM: s.remainingTenths / 10,
    gw0Xpts: gw0,
    fiveGwXpts: r2(perGw.reduce((a, b) => a + b, 0)),
    fiveGwDiscounted: discounted,
    perGw,
    maxClubInXI: maxClubXI,
    clubsOverTwoInXI: clubsOver2,
    benchXpts: r2(bench.reduce((a, p) => a + p0.get(p.id)!.ep, 0)),
    benchAvgStartProb: r2(avg(bench.filter((p) => p.pos !== "GKP").map((p) => p0.get(p.id)!.startProb))),
    xiAvgStartProb: r2(avg(xi.map((p) => p0.get(p.id)!.startProb))),
    xiMinStartProb: r2(Math.min(...xi.map((p) => p0.get(p.id)!.startProb))),
    xiAvgExpMinutes: Math.round(avg(xi.map((p) => p0.get(p.id)!.expMinutes))),
    xiBelowSecurityBar: below.map((p) => p.webName),
    xiXgi90Outfield: r2(xgi),
    xiAssistShareOfXgi: r2(xgi > 0 ? xa / xgi : 0),
    xiFormTiltXpts: r2(xi.reduce((a, p) => a + p0.get(p.id)!.components.formAdj, 0)),
    avgConfidence: r2(avg(players.map((p) => p0.get(p.id)!.confidenceScore))),
    captain: { id: cap.id, name: cap.webName, xpts: p0.get(cap.id)!.ep, startProb: p0.get(cap.id)!.startProb },
    vice: { id: vice.id, name: vice.webName, xpts: p0.get(vice.id)!.ep, startProb: p0.get(vice.id)!.startProb, sameClubAsCaptain: cap.teamId === vice.teamId },
  };
}

export interface ChangedPlayer {
  id: number;
  name: string;
  club: string;
  priceM: number;
  role: "XI" | "bench" | "not in squad";
  gw0Xpts: number;
  fiveGwValue: number;
}
export interface PlayerSwap {
  position: string;
  out: ChangedPlayer;
  in: ChangedPlayer;
  whyOut: string[];
  whyIn: string[];
  explanation: string;
}
export interface RoleChange {
  player: ChangedPlayer;
  from: string;
  to: string;
  explanation: string;
}

export function explainChanges(ds: Dataset, hz: Horizon, bp: BalancedPlusResult, base: StrategySquad) {
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const vals = bp.values;
  const p0 = hz.proj[0];
  const baseXI = new Set(base.starting);
  const baseAll = new Set([...base.starting, ...base.bench]);
  const bpXI = new Set(bp.starting);
  const bpAll = new Set(bp.squad);
  const club = (p: Player) => ds.teams[p.teamId].short;
  const baseClubCount = new Map<number, Player[]>();
  base.starting.forEach((id) => { const p = by.get(id)!; baseClubCount.set(p.teamId, [...(baseClubCount.get(p.teamId) ?? []), p]); });
  const bpClubCount = new Map<number, number>();
  bp.starting.forEach((id) => bpClubCount.set(by.get(id)!.teamId, (bpClubCount.get(by.get(id)!.teamId) ?? 0) + 1));
  const role = (id: number, xi: Set<number>, all: Set<number>): ChangedPlayer["role"] => (xi.has(id) ? "XI" : all.has(id) ? "bench" : "not in squad");
  const cp = (id: number, r: ChangedPlayer["role"]): ChangedPlayer => {
    const p = by.get(id)!;
    return { id, name: p.webName, club: club(p), priceM: p.cost, role: r, gw0Xpts: vals.get(id)!.ep0, fiveGwValue: vals.get(id)!.value };
  };
  const runFdr = (id: number) => {
    const f = hz.proj.flatMap((pm) => pm.get(id)!.fixtures);
    return f.length ? r2(avg(f.map((x) => x.difficulty))) : 0;
  };
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const B = BALANCED_PLUS;

  /** why the baseline's player does not make Balanced Plus' squad */
  const whyOut = (P: Player, inBaseXI: boolean, Q: Player): string[] => {
    const v = vals.get(P.id)!;
    const out: string[] = [];
    const mates = baseClubCount.get(P.teamId) ?? [];
    if (inBaseXI && mates.length > B.maxPerClubXI) out.push(`${base.label} started ${mates.length} ${club(P)} players (${mates.map((m) => m.webName).join(", ")}); Balanced Plus allows at most ${B.maxPerClubXI} per club in the XI.`);
    if (inBaseXI && !v.xiEligible) out.push(`Not secure enough for the XI: ${pct(v.startProb)} start probability and ~${v.expMinutes} expected minutes (bar: >=${pct(B.xiMinStartProb)}, >=${B.xiMinExpMinutes} min)${P.news ? `; news: ${P.news}` : ""}.`);
    if (!inBaseXI && !v.benchEligible) out.push(`Not a playable bench option: ${pct(v.startProb)} start probability, ${pct(v.availability)} availability${P.news ? ` (${P.news})` : ""}.`);
    if (v.formRemoved5 >= 0.15) out.push(`${v.formRemoved5.toFixed(2)} xPts (5-GW average) of the projection came from the recent-form tilt, which Balanced Plus removes.`);
    if (v.attackShift5 <= -0.15) out.push(`Realised returns (${P.goals}G ${P.assists}A) outrun underlying numbers (xG ${P.xG.toFixed(1)}, xA ${P.xA.toFixed(1)}); rebuilt on xG/xA the value drops ${(-v.attackShift5).toFixed(2)}.`);
    if (v.value + 0.05 < vals.get(Q.id)!.value) out.push(`Lower five-gameweek value: ${v.value.toFixed(2)} vs ${vals.get(Q.id)!.value.toFixed(2)} for ${Q.webName}.`);
    if (out.length === 0) {
      out.push(`Squad-level trade-off: ${Q.webName} is not individually better (five-gameweek value ${vals.get(Q.id)!.value.toFixed(2)} vs ${v.value.toFixed(2)}); the optimiser chose the combination with the highest total five-gameweek value under the XI club cap, the bench target and £100m.`);
    }
    const dp = P.cost - Q.cost;
    if (Math.abs(dp) >= 0.5) out.push(`Price: ${P.webName} £${P.cost.toFixed(1)}m vs ${Q.webName} £${Q.cost.toFixed(1)}m (${dp > 0 ? `£${dp.toFixed(1)}m cheaper` : `£${(-dp).toFixed(1)}m dearer`} with Balanced Plus).`);
    return out;
  };
  const whyIn = (Q: Player, inBpXI: boolean): string[] => {
    const v = vals.get(Q.id)!;
    const out: string[] = [];
    out.push(inBpXI ? `Secure starter: ${pct(v.startProb)} start probability, ~${v.expMinutes} expected minutes.` : `${Q.pos === "GKP" ? "Fit substitute keeper" : "Playable bench option"}: ${pct(v.startProb)} start probability, ${pct(v.availability)} available.`);
    if (Q.pos !== "GKP") out.push(`Underlying attack: xGI/90 ${Q.xGI90.toFixed(2)} (xG ${Q.xG.toFixed(1)}, xA ${Q.xA.toFixed(1)}), not just returns (${Q.goals}G ${Q.assists}A).`);
    out.push(`Five-gameweek value ${v.value.toFixed(2)} (raw model ${v.rawEp5.toFixed(2)}); next-five fixture difficulty ${runFdr(Q.id) || "n/a"}.`);
    if (inBpXI && (bpClubCount.get(Q.teamId) ?? 0) <= B.maxPerClubXI) out.push(`Keeps ${club(Q)} at ${bpClubCount.get(Q.teamId)} in the XI (limit ${B.maxPerClubXI}).`);
    return out;
  };

  const swaps: PlayerSwap[] = [];
  for (const pos of ["GKP", "DEF", "MID", "FWD"] as const) {
    const removed = base.starting.concat(base.bench).filter((id) => !bpAll.has(id) && by.get(id)!.pos === pos).sort((a, b) => Number(baseXI.has(b)) - Number(baseXI.has(a)) || vals.get(b)!.value - vals.get(a)!.value);
    const added = bp.squad.filter((id) => !baseAll.has(id) && by.get(id)!.pos === pos).sort((a, b) => Number(bpXI.has(b)) - Number(bpXI.has(a)) || vals.get(b)!.value - vals.get(a)!.value);
    removed.forEach((oid, i) => {
      const iid = added[i];
      if (iid === undefined) return;
      const P = by.get(oid)!;
      const Q = by.get(iid)!;
      const wo = whyOut(P, baseXI.has(oid), Q);
      const wi = whyIn(Q, bpXI.has(iid));
      const o = cp(oid, role(oid, baseXI, baseAll));
      const n = cp(iid, role(iid, bpXI, bpAll));
      swaps.push({
        position: pos,
        out: o,
        in: n,
        whyOut: wo,
        whyIn: wi,
        explanation: `${P.webName} (${club(P)}, £${P.cost.toFixed(1)}m, ${o.role} in ${base.label}) -> ${Q.webName} (${club(Q)}, £${Q.cost.toFixed(1)}m, ${n.role} in Balanced Plus). GW${hz.gws[0]} xPts ${o.gw0Xpts.toFixed(2)} -> ${n.gw0Xpts.toFixed(2)}; five-GW value ${o.fiveGwValue.toFixed(2)} -> ${n.fiveGwValue.toFixed(2)}. Out: ${wo.join(" ")} In: ${wi.join(" ")}`,
      });
    });
  }

  const roleChanges: RoleChange[] = [];
  for (const id of bp.squad) {
    if (!baseAll.has(id)) continue;
    const a = baseXI.has(id) ? "XI" : "bench";
    const b = bpXI.has(id) ? "XI" : "bench";
    if (a === b) continue;
    const P = by.get(id)!;
    const v = vals.get(id)!;
    const why: string[] = [];
    if (a === "XI" && b === "bench") {
      const mates = baseClubCount.get(P.teamId) ?? [];
      if (mates.length > B.maxPerClubXI) why.push(`${base.label} started ${mates.length} ${club(P)} players; Balanced Plus keeps at most ${B.maxPerClubXI} in the XI and ${P.webName} is not among its top ${B.maxPerClubXI} by value for this gameweek.`);
      if (!v.xiEligible) why.push(`${pct(v.startProb)} start probability / ~${v.expMinutes} expected minutes is below the XI bar.`);
      why.push(`Five-gameweek value ${v.value.toFixed(2)} ranks below the players Balanced Plus starts.`);
    } else {
      why.push(`Secure starter (${pct(v.startProb)} start, ~${v.expMinutes} min) with five-gameweek value ${v.value.toFixed(2)}.`);
      if (v.xiEligible) why.push(`Within the ${B.maxPerClubXI}-per-club XI limit (${club(P)}: ${bpClubCount.get(P.teamId)}).`);
    }
    roleChanges.push({ player: cp(id, b === "XI" ? "XI" : "bench"), from: a, to: b, explanation: `${P.webName} moves from ${a} to ${b}. ${why.join(" ")}` });
  }

  const capSame = base.captain === bp.captain;
  const vSame = base.vice === bp.viceCaptain;
  const nm = (id: number) => by.get(id)!.webName;
  const captaincy = {
    sameCaptain: capSame,
    sameVice: vSame,
    explanation: `Captain: ${base.label}: ${nm(base.captain)} (${p0.get(base.captain)!.ep.toFixed(2)} xPts) | Balanced Plus: ${nm(bp.captain)} (${p0.get(bp.captain)!.ep.toFixed(2)} xPts)${capSame ? ": same pick (highest model xPts in the XI)" : `: Balanced Plus picks the highest model xPts in its own XI${base.starting.includes(bp.captain) ? "" : `, and ${nm(base.captain)} is not in its XI`}`}. Vice: ${base.label}: ${nm(base.vice)} | Balanced Plus: ${nm(bp.viceCaptain)}${vSame ? ": same pick" : `: ${bp.captaincy.viceRule}`}.`,
  };

  const changedCount = swaps.length + roleChanges.length;
  return { against: base.key, againstLabel: base.label, overlap: [...bpAll].filter((id) => baseAll.has(id)).length, changedPlayers: swaps.length, roleChanges, swaps, captaincy, totalChanges: changedCount };
}

export function compareAll(ds: Dataset, hz: Horizon, bp: BalancedPlusResult, baselines: StrategySquad[]) {
  const all = [...baselines, balancedPlusSquad(bp)];
  return {
    gw: hz.gws[0],
    metrics: all.map((s) => strategyMetrics(ds, hz, s)),
    changes: baselines.map((b) => explainChanges(ds, hz, bp, b)),
    notes: [
      `GW${hz.gws[0]} xPts = the XI each strategy actually chose + its captain's extra points. GW${hz.gws[1] ?? "-"} onward use each squad's best XI (unconstrained) so every strategy is measured the same way.`,
      "All four strategies use the same FPL data snapshot and the same £100m budget; Balanced, Safe and Aggressive come from the unchanged optimiser.",
    ],
  };
}
