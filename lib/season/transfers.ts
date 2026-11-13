import type { Dataset, Player, Pos } from "../fpl/types";
import { POSITIONS } from "../fpl/types";
import { averageDifficulty } from "../analytics/fixtureAnalysis";
import { sellingPrice, transferCost, nextFreeTransfers } from "./rules";
import { buildHorizon, playerHorizonEp, squadValue, type Horizon } from "./horizon";
import { byIdMap, holdingSellTenths } from "./squad";
import type { SeasonSquad } from "./types";

/** Heuristic worth (in points) of each free transfer still banked after this week, diminishing above 3. */
export function bankValue(ftAfter: number): number {
  const first = Math.min(Math.max(ftAfter - 1, 0), 2) * 1.2;
  const more = Math.max(ftAfter - 3, 0) * 0.4;
  return first + more;
}
/** A transfer must beat saving by at least this many points to be recommended. */
export const MIN_EDGE = 0.5;
/** A -4 hit additionally needs this safety margin on the net gain. */
export const HIT_MARGIN = 1.5;
const MAX_TRANSFERS = 4;
const BEAM = 6;

export interface TransferDetail {
  out: number;
  in: number;
  sellTenths: number;
  buyTenths: number;
  priceDiffTenths: number;
  /** marginal change in this gameweek's expected points (captain included) */
  gainGw: number;
  /** marginal change in discounted expected points over the next 5 gameweeks */
  gainHorizon: number;
  /** points deducted for this transfer (0 while free transfers last, else 4) */
  deduction: number;
  net: number;
  differential: boolean;
  explanation: string;
}

export interface TransferOption {
  n: number;
  label: string;
  transfers: TransferDetail[];
  hitCost: number;
  freeUsed: number;
  ftAfter: number;
  gainGw: number;
  gainHorizon: number;
  /** gainHorizon - hitCost */
  net: number;
  /** net + value of the free transfers still banked: what the decision compares */
  score: number;
  bankAfterTenths: number;
}

export interface SellCandidate {
  out: number;
  sellTenths: number;
  reason: string;
  alternatives: TransferDetail[];
}

export interface TransferAnalysis {
  gw: number;
  horizonGws: number[];
  freeTransfers: number;
  bankTenths: number;
  options: TransferOption[];
  recommendedN: number;
  action: "save" | "transfer" | "hit";
  headline: string;
  reason: string;
  sellCandidates: SellCandidate[];
}

interface State {
  players: Player[];
  holdings: Map<number, number>; // id -> buy price
  bank: number;
  swaps: { out: number; in: number }[];
  value: number;
  perGw: number[];
}

const key = (swaps: { out: number; in: number }[]) => swaps.map((s) => `${s.out}>${s.in}`).sort().join("|");

function legalSwap(st: State, outP: Player, inP: Player, ds: Dataset): number | null {
  if (outP.pos !== inP.pos) return null;
  if (st.holdings.has(inP.id)) return null;
  const sell = sellingPrice(st.holdings.get(outP.id)!, outP.costTenths, ds.rules.sellOnFee);
  const bank = st.bank + sell - inP.costTenths;
  if (bank < 0) return null;
  let sameClub = 0;
  for (const p of st.players) if (p.teamId === inP.teamId && p.id !== outP.id) sameClub++;
  if (sameClub >= ds.rules.teamLimit) return null;
  return bank;
}

function swapState(st: State, outP: Player, inP: Player, hz: Horizon, ds: Dataset): State | null {
  const bank = legalSwap(st, outP, inP, ds);
  if (bank === null) return null;
  const players = st.players.map((p) => (p.id === outP.id ? inP : p));
  const holdings = new Map(st.holdings);
  holdings.delete(outP.id);
  holdings.set(inP.id, inP.costTenths);
  const v = squadValue(players, hz, ds);
  return { players, holdings, bank, swaps: [...st.swaps, { out: outP.id, in: inP.id }], value: v.weighted, perGw: v.perGw };
}

function candidatePool(ds: Dataset, hz: Horizon): Record<Pos, Player[]> {
  const pool = {} as Record<Pos, Player[]>;
  for (const pos of POSITIONS) {
    const ps = ds.players.filter((p) => p.pos === pos && p.status !== "u" && p.status !== "n" && (hz.proj[0].get(p.id)?.availability ?? 0) > 0);
    const ep = (p: Player) => playerHorizonEp(p.id, hz);
    const keep = new Map<number, Player>();
    [...ps].sort((a, b) => ep(b) - ep(a)).slice(0, 30).forEach((p) => keep.set(p.id, p));
    [...ps].sort((a, b) => ep(b) / b.costTenths - ep(a) / a.costTenths).slice(0, 12).forEach((p) => keep.set(p.id, p));
    // best player at each price point: lets the search free up budget for upgrades
    const best = new Map<number, Player>();
    for (const p of [...ps].sort((a, b) => ep(b) - ep(a))) if (!best.has(p.costTenths)) best.set(p.costTenths, p);
    [...best.values()].forEach((p) => keep.set(p.id, p));
    pool[pos] = [...keep.values()];
  }
  return pool;
}

function explain(outP: Player, inP: Player, hz: Horizon, d: { gainGw: number; gainHorizon: number; priceDiff: number }): string {
  const o0 = hz.display.get(outP.id)!;
  const i0 = hz.display.get(inP.id)!;
  const parts: string[] = [];
  if (outP.status === "u" || outP.status === "s" || outP.status === "i" || o0.availability < 0.75) {
    parts.push(`${outP.webName} is a ${o0.availability === 0 ? "non-starter" : "doubt"}${outP.news ? ` (${outP.news})` : ""}.`);
  } else if (o0.startProb < 0.6) parts.push(`${outP.webName} is not a secure starter (${Math.round(o0.startProb * 100)}% start).`);
  else parts.push(`${outP.webName} projects ${o0.ep.toFixed(1)} pts next GW and ${playerHorizonEp(outP.id, hz).toFixed(1)} over the run.`);
  const diffIn = averageDifficulty(hz.proj.slice(0, 5).flatMap((m) => m.get(inP.id)!.fixtures));
  const diffOut = averageDifficulty(hz.proj.slice(0, 5).flatMap((m) => m.get(outP.id)!.fixtures));
  parts.push(
    `${inP.webName} projects ${i0.ep.toFixed(1)} pts (${Math.round(i0.startProb * 100)}% to start), xGI/90 ${inP.xGI90.toFixed(2)}, form ${inP.form}` +
      (diffIn && diffOut ? `, next-5 fixture difficulty ${diffIn.toFixed(1)} vs ${diffOut.toFixed(1)}.` : "."),
  );
  if (inP.ownership < 10) parts.push(`Differential: ${inP.ownership}% owned.`);
  parts.push(`${d.priceDiff === 0 ? "Same price" : d.priceDiff > 0 ? `Costs £${(d.priceDiff / 10).toFixed(1)}m more` : `Frees £${(-d.priceDiff / 10).toFixed(1)}m`}; ${d.gainHorizon >= 0 ? "+" : ""}${d.gainHorizon.toFixed(1)} weighted pts over ${hz.gws.length} GWs.`);
  return parts.join(" ");
}

function detailChain(base: State, final: State, hz: Horizon, ds: Dataset, ft: number): TransferDetail[] {
  const by = byIdMap(ds);
  let st = base;
  const out: TransferDetail[] = [];
  final.swaps.forEach((s, i) => {
    const outP = by.get(s.out)!;
    const inP = by.get(s.in)!;
    const sell = sellingPrice(st.holdings.get(s.out)!, outP.costTenths, ds.rules.sellOnFee);
    const next = swapState(st, outP, inP, hz, ds)!;
    const gainH = next.value - st.value;
    const gainGw = next.perGw[0] - st.perGw[0];
    const deduction = i >= ft ? ds.rules.transferHit : 0;
    out.push({
      out: s.out,
      in: s.in,
      sellTenths: sell,
      buyTenths: inP.costTenths,
      priceDiffTenths: inP.costTenths - sell,
      gainGw: round(gainGw),
      gainHorizon: round(gainH),
      deduction,
      net: round(gainH - deduction),
      differential: inP.ownership < 10,
      explanation: explain(outP, inP, hz, { gainGw, gainHorizon: gainH, priceDiff: inP.costTenths - sell }),
    });
    st = next;
  });
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

const LABELS = ["Save your free transfer", "Make one transfer", "Make two transfers", "Consider a -4 hit (3 transfers)", "Consider two hits (4 transfers)"];

/**
 * Transfer optimiser. Searches 0..4 transfers (beam search over legal swaps, using real selling prices,
 * bank, club limits and positions), then decides between SAVING and using transfers by comparing
 *   net = (discounted 5-GW expected points after - before) - hit cost
 * plus the heuristic value of the free transfers left banked. It never forces a transfer.
 */
export interface AnalyseOptions {
  /** multiplies MIN_EDGE and HIT_MARGIN (use > 1 when the horizon's discount weights sum to more than the default five-gameweek horizon) */
  edgeScale?: number;
  /** multiplies the value of free transfers left banked */
  bankScale?: number;
}

export function analyseTransfers(ds: Dataset, base: SeasonSquad, gw: number, hzIn?: Horizon, opts: AnalyseOptions = {}): TransferAnalysis {
  const edgeScale = opts.edgeScale ?? 1;
  const bankScale = opts.bankScale ?? 1;
  const bankV = (n: number) => bankValue(n) * bankScale;
  const hz = hzIn ?? buildHorizon(ds, gw);
  const by = byIdMap(ds);
  const players = base.holdings.map((h) => by.get(h.id)!);
  const v0 = squadValue(players, hz, ds);
  const st0: State = { players, holdings: new Map(base.holdings.map((h) => [h.id, h.buyTenths])), bank: base.bankTenths, swaps: [], value: v0.weighted, perGw: v0.perGw };
  const pool = candidatePool(ds, hz);
  const ft = base.freeTransfers;

  // Level 1 over EVERY squad player (also feeds the per-player "sell" lists).
  const singles: State[] = [];
  const perOut = new Map<number, State[]>();
  for (const outP of players) {
    const res: State[] = [];
    for (const inP of pool[outP.pos]) {
      const s = swapState(st0, outP, inP, hz, ds);
      if (s) res.push(s);
    }
    res.sort((a, b) => b.value - a.value);
    perOut.set(outP.id, res);
    singles.push(...res);
  }
  singles.sort((a, b) => b.value - a.value);

  // Beam for 2..MAX transfers; only the weakest players (and doubts) are sold.
  const sellable = [...players]
    .sort((a, b) => playerHorizonEp(a.id, hz) - playerHorizonEp(b.id, hz))
    .slice(0, 9)
    .map((p) => p.id);
  for (const p of players) if ((hz.proj[0].get(p.id)?.availability ?? 1) < 0.75 && !sellable.includes(p.id)) sellable.push(p.id);

  const best: (State | null)[] = [st0, null, null, null, null];
  let beam: State[] = [];
  const seen = new Set<string>();
  for (const s of singles) {
    const k = key(s.swaps);
    if (seen.has(k)) continue;
    seen.add(k);
    beam.push(s);
    if (beam.length >= BEAM) break;
  }
  best[1] = beam[0] ?? null;
  for (let level = 2; level <= MAX_TRANSFERS && beam.length; level++) {
    const next: State[] = [];
    const nseen = new Set<string>();
    for (const st of beam) {
      const bought = new Set(st.swaps.map((s) => s.in));
      const cands: State[] = [];
      for (const outId of sellable) {
        if (!st.holdings.has(outId) || bought.has(outId) || st.swaps.some((s) => s.out === outId)) continue;
        const outP = by.get(outId)!;
        for (const inP of pool[outP.pos]) {
          const s = swapState(st, outP, inP, hz, ds);
          if (s) cands.push(s);
        }
      }
      cands.sort((a, b) => b.value - a.value);
      for (const c of cands.slice(0, BEAM)) {
        const k = key(c.swaps);
        if (nseen.has(k)) continue;
        nseen.add(k);
        next.push(c);
      }
    }
    next.sort((a, b) => b.value - a.value);
    beam = next.slice(0, BEAM);
    best[level] = beam[0] ?? null;
  }

  const options: TransferOption[] = [];
  for (let n = 0; n <= MAX_TRANSFERS; n++) {
    const st = best[n];
    if (!st) continue;
    // A later level that is not better than a shallower one is dominated: never worse to do less.
    const { cost, freeUsed } = transferCost(n, ft, null, ds.rules);
    const details = n === 0 ? [] : detailChain(st0, st, hz, ds, ft);
    const gainH = st.value - st0.value;
    const ftAfter = nextFreeTransfers(ft, n, null, ds.rules);
    const net = gainH - cost;
    options.push({
      n,
      label: n <= 2 ? LABELS[n] : n - ft > 0 ? `Consider ${n - ft === 1 ? "a -4 hit" : `${n - ft} hits`} (${n} transfers)` : `Make ${n} transfers`,
      transfers: details,
      hitCost: cost,
      freeUsed,
      ftAfter,
      gainGw: round(st.perGw[0] - st0.perGw[0]),
      gainHorizon: round(gainH),
      net: round(net),
      score: round(net + bankV(ftAfter)),
      bankAfterTenths: st.bank,
    });
  }

  // Decision: save unless a transfer plan clearly beats it.
  const save = options[0];
  let chosen = save;
  for (const o of options.slice(1)) {
    const margin = (MIN_EDGE + (o.hitCost > 0 ? HIT_MARGIN : 0)) * edgeScale;
    if (o.score > chosen.score + (chosen === save ? margin : 0) && o.score >= save.score + margin) chosen = o;
  }
  const action: TransferAnalysis["action"] = chosen.n === 0 ? "save" : chosen.hitCost > 0 ? "hit" : "transfer";
  let headline = chosen.label;
  let reason: string;
  if (chosen.n === 0) {
    const top = options[1];
    headline = ft >= ds.rules.maxFreeTransfers ? "No strong move: but you are at the cap" : ft > 1 ? `Save your free transfers (${ft} banked)` : "Save your free transfer";
    reason = top
      ? `The best single move gains only ${top.gainHorizon.toFixed(1)} weighted pts over ${hz.gws.length} GWs; banking is worth about ${(bankV(save.ftAfter) - bankV(top.ftAfter)).toFixed(1)} more than using it. No transfer clears the bar.`
      : "No legal improving transfer found.";
  } else if (chosen.hitCost > 0) {
    reason = `${chosen.n} transfers gain ${chosen.gainHorizon.toFixed(1)} weighted pts; after the -${chosen.hitCost} hit that is ${chosen.net.toFixed(1)} net, clearly better than saving.`;
  } else {
    reason = `Net +${chosen.net.toFixed(1)} weighted pts over ${hz.gws.length} GWs for free, ahead of saving (the next-best use of a transfer is banking it).`;
  }

  // "Sell" list: up to five alternatives for every player, weakest first.
  const sellCandidates: SellCandidate[] = players
    .map((outP) => {
      const alts = (perOut.get(outP.id) ?? []).slice(0, 5).map((s) => {
        const d = detailChain(st0, s, hz, ds, ft)[0];
        return { ...d, deduction: ft > 0 ? 0 : ds.rules.transferHit, net: round(d.gainHorizon - (ft > 0 ? 0 : ds.rules.transferHit)) };
      });
      const o0 = hz.display.get(outP.id)!;
      const reasonText =
        o0.availability < 0.75
          ? `Availability doubt${outP.news ? `: ${outP.news}` : ""}`
          : o0.startProb < 0.6
            ? "Not a secure starter"
            : `Projects ${o0.ep.toFixed(1)} next GW`;
      const h = base.holdings.find((x) => x.id === outP.id)!;
      return { out: outP.id, sellTenths: holdingSellTenths(h, outP, ds), reason: reasonText, alternatives: alts };
    })
    .sort((a, b) => (b.alternatives[0]?.gainHorizon ?? -99) - (a.alternatives[0]?.gainHorizon ?? -99));

  return { gw, horizonGws: hz.gws, freeTransfers: ft, bankTenths: base.bankTenths, options, recommendedN: chosen.n, action, headline, reason, sellCandidates };
}
