import { blockBootstrapCI, mean, median, ranks, sd, signTest, tInterval, variance } from "./stats";
import type { StrategyDef, WindowRecord } from "./run";

export const NON_OVERLAPPING = (k: number, firstK: number, step = 5) => (k - firstK) % step === 0;
const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

export interface PairedStats {
  vs: string;
  /** every rolling window (overlapping, so dependent) */
  nWindows: number;
  /** windows that share no gameweek (approximately independent) */
  nNonOverlapping: number;
  meanDiff: number | null;
  medianDiff: number | null;
  sdDiff: number | null;
  varianceDiff: number | null;
  /** 95% t interval on the non-overlapping windows (valid under independence) */
  tCI95NonOverlapping: [number | null, number | null];
  /** 95% moving-block bootstrap interval on all rolling windows (accounts for the 5-window overlap) */
  blockBootstrapCI95: [number | null, number | null];
  /** sign test on non-overlapping windows */
  signTest: { wins: number; losses: number; ties: number; p: number };
  effectSize: number | null;
  /** statistically distinguishable from zero at 95% by BOTH intervals */
  evidence: "advantage" | "disadvantage" | "no-evidence-of-difference";
}

export function pairedStats(windows: WindowRecord[], id: string, baseline: string, firstKBySeason: Record<string, number>, windowLen = 5): PairedStats {
  const bySeason = new Map<string, WindowRecord[]>();
  for (const w of windows) (bySeason.get(w.season) ?? bySeason.set(w.season, []).get(w.season)!).push(w);
  const series: number[][] = [];
  const nonOverlap: number[] = [];
  const all: number[] = [];
  for (const [season, ws] of bySeason) {
    const ordered = [...ws].sort((a, b) => a.k - b.k);
    const d = ordered.map((w) => w.strategies[id].points - w.strategies[baseline].points);
    series.push(d);
    all.push(...d);
    ordered.forEach((w, i) => { if (NON_OVERLAPPING(w.k, firstKBySeason[season] ?? ordered[0].k, windowLen)) nonOverlap.push(d[i]); });
  }
  const t = nonOverlap.length > 1 ? tInterval(nonOverlap) : null;
  const bb = all.length >= 10 ? blockBootstrapCI(series, windowLen) : null;
  const sg = signTest(nonOverlap);
  const excl0 = (lo: number | null | undefined, hi: number | null | undefined) => lo != null && hi != null && (lo > 0 || hi < 0);
  const both = excl0(t?.lo, t?.hi) && excl0(bb?.lo, bb?.hi) && Math.sign(t!.mean) === Math.sign(bb!.mean);
  return {
    vs: baseline,
    nWindows: all.length,
    nNonOverlapping: nonOverlap.length,
    meanDiff: r3(mean(all)),
    medianDiff: r3(median(all)),
    sdDiff: r3(sd(all)),
    varianceDiff: r3(variance(all)),
    tCI95NonOverlapping: [r3(t?.lo ?? NaN), r3(t?.hi ?? NaN)],
    blockBootstrapCI95: [r3(bb?.lo ?? NaN), r3(bb?.hi ?? NaN)],
    signTest: sg,
    effectSize: r3(mean(all) / sd(all)),
    evidence: both ? (mean(all) > 0 ? "advantage" : "disadvantage") : "no-evidence-of-difference",
  };
}

export function summarise(windows: WindowRecord[], strategies: StrategyDef[], baseline = "balanced", firstKBySeason: Record<string, number> = {}, windowLen = 5) {
  const ids = strategies.map((s) => s.id);
  const perStrategy = ids.map((id) => {
    const ws = windows.map((w) => w.strategies[id]);
    const gws = ws.flatMap((w) => w.gws);
    const n = gws.length;
    const winPts = ws.map((w) => w.points);
    const formation: Record<string, { gameweeks: number; meanPoints: number }> = {};
    const f: Record<string, number[]> = {};
    gws.forEach((g) => (f[g.formation] ??= []).push(g.actual));
    for (const [k, v] of Object.entries(f)) formation[k] = { gameweeks: v.length, meanPoints: r3(mean(v)) as number };
    const capPts = gws.map((g) => g.captainPoints);
    return {
      id,
      label: strategies.find((s) => s.id === id)!.label,
      windows: ws.length,
      gameweeks: n,
      meanWindowPoints: r3(mean(winPts)),
      medianWindowPoints: r3(median(winPts)),
      sdWindowPoints: r3(sd(winPts)),
      meanPointsPerGw: r3(mean(gws.map((g) => g.actual))),
      xiPointsPerGw: r3(mean(gws.map((g) => g.basePoints))),
      captainPointsPerGw: r3(mean(capPts)),
      captain: {
        meanPoints: r3(mean(capPts)),
        blankRate: r3(capPts.filter((p) => p <= 2).length / n),
        haulRate: r3(capPts.filter((p) => p >= 10).length / n),
        didNotPlayRate: r3(gws.filter((g) => g.captainDidNotPlay).length / n),
        meanRankInXI: r3(mean(gws.map((g) => g.captainRank))),
        meanRegretVsBestInXI: r3(mean(gws.map((g) => g.captainRegret))),
      },
      projectedVsActual: {
        meanProjectedPerGw: r3(mean(gws.map((g) => g.proj))),
        meanActualPerGw: r3(mean(gws.map((g) => g.actual))),
        biasPerGw: r3(mean(gws.map((g) => g.proj - g.actual))),
        squadMAEPerGw: r3(mean(gws.map((g) => Math.abs(g.proj - g.actual)))),
        windowMAE: r3(mean(ws.map((w) => Math.abs(w.projected - w.points)))),
        playerMAE: r3(mean(gws.map((g) => g.playerAbsErr))),
        playerBias: r3(mean(gws.map((g) => g.playerBias))),
      },
      startingXI: {
        meanMinutesPerStarter: r3(mean(gws.map((g) => g.xiMinutesAvg))),
        didNotPlayRate: r3(gws.reduce((a, g) => a + g.xiDnp, 0) / (11 * n)),
        under60Rate: r3(gws.reduce((a, g) => a + g.xiUnder60, 0) / (11 * n)),
        autoSubsPerGw: r3(mean(gws.map((g) => g.autoSubs))),
      },
      bench: {
        pointsAddedByAutoSubsPerGw: r3(mean(gws.map((g) => g.benchUsedPoints))),
        unusedBenchPointsPerGw: r3(mean(gws.map((g) => g.benchUnusedPoints))),
      },
      clubConcentration: { meanMaxFromOneClubInXI: r3(mean(gws.map((g) => g.maxClubXI))), shareOfGwsWith3Plus: r3(gws.filter((g) => g.maxClubXI >= 3).length / n) },
      byFormation: formation,
      lineupRelaxedShare: r3(gws.filter((g) => g.relaxed !== "none").length / n),
    };
  });

  // wins and ranks across windows
  const wins: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
  const outright: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
  const rankSum: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
  for (const w of windows) {
    const pts = ids.map((i) => w.strategies[i].points);
    const best = Math.max(...pts);
    const top = ids.filter((_, j) => pts[j] === best);
    top.forEach((i) => (wins[i] += 1 / top.length));
    if (top.length === 1) outright[top[0]]++;
    ranks(pts).forEach((r, j) => (rankSum[ids[j]] += r));
  }
  const n = windows.length;
  const winShare = Object.fromEntries(ids.map((i) => [i, { sharedWinPct: r3((100 * wins[i]) / n), outrightWinPct: r3((100 * outright[i]) / n), averageRank: r3(rankSum[i] / n) }]));

  const paired = Object.fromEntries(ids.filter((i) => i !== baseline).map((i) => [i, pairedStats(windows, i, baseline, firstKBySeason, windowLen)]));

  // rotation split (post hoc classification of periods, NEVER used for selection)
  const rot = windows.map((w) => w.rotation).filter(Number.isFinite);
  const cut = median(rot);
  const split = (high: boolean) => {
    const ws = windows.filter((w) => Number.isFinite(w.rotation) && (w.rotation > cut) === high);
    const out: Record<string, { n: number; meanWindowPoints: number | null; diffVsBaseline: number | null }> = {};
    for (const i of ids) out[i] = { n: ws.length, meanWindowPoints: r3(mean(ws.map((w) => w.strategies[i].points))), diffVsBaseline: r3(mean(ws.map((w) => w.strategies[i].points - w.strategies[baseline].points))) };
    return out;
  };
  const rotation = { medianRotationIndex: r3(cut), high: split(true), low: split(false) };

  return { windows: n, strategies: perStrategy, windowResults: winShare, pairedVsBaseline: paired, rotation };
}
