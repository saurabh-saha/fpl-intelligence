/**
 * Historical backtest. For each past gameweek k we rebuild the dataset using ONLY information
 * available before that gameweek's deadline (per-gameweek history rows with round < k, fixtures
 * finished before k, the price at k-1), run the same model + optimiser, and compare with actual points.
 *
 *   npm run backtest            # defaults to GW5..last finished
 *   FROM=5 TO=10 npm run backtest
 *
 * Caveat: injury/availability news is not point-in-time in the public API, so every player is
 * treated as available. This slightly flatters nobody: both model and baseline get the same treatment.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchBootstrap, fetchElementSummary, fetchFixtures } from "../lib/fpl/client";
import { num, deriveTeamStats } from "../lib/fpl/normalizer";
import { normalizeDataset } from "../lib/fpl/normalizer";
import { projectAll } from "../lib/analytics/playerScoring";
import { optimizeSquad } from "../lib/optimizer/squadOptimizer";
import { bestLineup } from "../lib/optimizer/formationOptimizer";
import type { Dataset, Player, Projection } from "../lib/fpl/types";

const CACHE = path.join(process.cwd(), ".cache", "history");

async function history(id: number): Promise<any[]> {
  const f = path.join(CACHE, `${id}.json`);
  try {
    return JSON.parse(await fs.readFile(f, "utf8"));
  } catch {
    /* fetch below */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const h = (await fetchElementSummary(id)).history ?? [];
      await fs.writeFile(f, JSON.stringify(h));
      return h;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + num(r[k]), 0);

function pointInTime(base: Dataset, hist: Map<number, any[]>, k: number, totalPlayers: number): Dataset {
  const players: Player[] = base.players.map((p) => {
    const rows = (hist.get(p.id) ?? []).filter((r) => r.round < k);
    const played = rows.filter((r) => r.minutes > 0);
    const minutes = sum(rows, "minutes");
    const per90 = (t: number) => (minutes > 0 ? (t / minutes) * 90 : 0);
    const xG = sum(rows, "expected_goals");
    const xA = sum(rows, "expected_assists");
    const last = rows[rows.length - 1];
    const recent = played.slice(-3);
    const totalPts = sum(rows, "total_points");
    return {
      ...p,
      costTenths: last ? num(last.value) : p.costTenths,
      cost: (last ? num(last.value) : p.costTenths) / 10,
      totalPoints: totalPts,
      ppg: played.length ? totalPts / played.length : 0,
      form: recent.length ? sum(recent, "total_points") / recent.length : 0,
      ownership: last ? (num(last.selected) / totalPlayers) * 100 : 0,
      minutes,
      starts: sum(rows, "starts"),
      goals: sum(rows, "goals_scored"),
      assists: sum(rows, "assists"),
      xG,
      xA,
      xGI: xG + xA,
      xG90: per90(xG),
      xA90: per90(xA),
      xGI90: per90(xG + xA),
      cleanSheets: sum(rows, "clean_sheets"),
      goalsConceded: sum(rows, "goals_conceded"),
      xGC: sum(rows, "expected_goals_conceded"),
      saves: sum(rows, "saves"),
      bonus: sum(rows, "bonus"),
      bps: sum(rows, "bps"),
      defContrib: sum(rows, "defensive_contribution"),
      defContrib90: per90(sum(rows, "defensive_contribution")),
      yellow: sum(rows, "yellow_cards"),
      red: sum(rows, "red_cards"),
      // availability news is not point-in-time: treat everyone as available
      status: "a",
      chanceNext: null,
      news: "",
    };
  });
  const fixtures = base.fixtures.map((f) => ({ ...f, finished: f.finished && f.event !== null && f.event < k }));
  const teams = JSON.parse(JSON.stringify(base.teams));
  deriveTeamStats(teams, fixtures, players);
  const events = base.events.map((e) => ({ ...e, isNext: e.id === k, isCurrent: e.id === k - 1, finished: e.id < k }));
  return { ...base, players, fixtures, teams, events };
}

const actualPoints = (hist: Map<number, any[]>, id: number, k: number) =>
  (hist.get(id) ?? []).filter((r) => r.round === k).reduce((s, r) => s + num(r.total_points), 0);

const mae = (xs: number[]) => xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length;
const rmse = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const [bootstrap, fixturesRaw] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
  const base = normalizeDataset(bootstrap, fixturesRaw, { fetchedAt: new Date().toISOString(), source: "live", stale: false });
  const lastFinished = Math.max(...base.events.filter((e) => e.finished).map((e) => e.id));
  const from = Number(process.env.FROM ?? 5);
  const to = Number(process.env.TO ?? lastFinished);
  console.log(`Backtesting GW${from}..GW${to} (${base.players.length} players)`);

  const withMinutes = base.players.filter((p) => p.minutes > 0 || p.status === "a");
  console.log(`Fetching histories for ${withMinutes.length} players (cached in .cache/history)...`);
  const hist = new Map<number, any[]>();
  await pool(withMinutes, 6, async (p) => hist.set(p.id, await history(p.id)));

  const perGw: any[] = [];
  const err = { model: [] as number[], base: [] as number[] };
  for (let k = from; k <= to; k++) {
    const ds = pointInTime(base, hist, k, bootstrap.total_players ?? 1);
    const { byId } = projectAll(ds, k, { mode: "balanced" });
    const baseProj = new Map<number, Projection>();
    for (const p of ds.players) {
      const pr = byId.get(p.id)!;
      const v = p.ppg * pr.fixtures.length;
      baseProj.set(p.id, { ...pr, ep: v, score: v });
    }
    // 1) per-player error among players with a track record (>= 3 prior appearances and 270 min)
    const eligible = ds.players.filter((p) => p.minutes >= 270 && byId.get(p.id)!.fixtures.length > 0);
    const e1 = eligible.map((p) => byId.get(p.id)!.ep - actualPoints(hist, p.id, k));
    const e2 = eligible.map((p) => baseProj.get(p.id)!.ep - actualPoints(hist, p.id, k));
    err.model.push(...e1);
    err.base.push(...e2);

    // 2) captain: highest projection among regulars vs highest PPG
    const regulars = eligible.filter((p) => p.starts >= (k - 1) * 0.5);
    const capModel = [...regulars].sort((a, b) => byId.get(b.id)!.ep - byId.get(a.id)!.ep)[0];
    const capBase = [...regulars].sort((a, b) => b.ppg - a.ppg)[0];
    const capActualBest = Math.max(...regulars.map((p) => actualPoints(hist, p.id, k)));

    // 3) squad: optimise on each projection, then score with ACTUAL points (captain x2)
    const squadScore = (proj: Map<number, Projection>) => {
      const { result } = optimizeSquad(ds, proj, { mode: "balanced" });
      const sq = result.squad.map((id) => ds.players.find((p) => p.id === id)!);
      const lineup = bestLineup(sq, proj, ds.rules);
      const pts = lineup.starting.reduce((s, id) => s + actualPoints(hist, id, k), 0) + actualPoints(hist, lineup.captain, k);
      const predicted = lineup.starting.reduce((s, id) => s + proj.get(id)!.ep, 0) + proj.get(lineup.captain)!.ep;
      return { pts, predicted };
    };
    const sm = squadScore(byId);
    const sb = squadScore(baseProj);
    perGw.push({
      gw: k,
      players: eligible.length,
      modelMae: r2(mae(e1)),
      baselineMae: r2(mae(e2)),
      captainModel: { name: capModel.webName, points: actualPoints(hist, capModel.id, k) },
      captainBaseline: { name: capBase.webName, points: actualPoints(hist, capBase.id, k) },
      captainBestPossible: capActualBest,
      squadModel: { predicted: r2(sm.predicted), actual: sm.pts },
      squadBaseline: { predicted: r2(sb.predicted), actual: sb.pts },
    });
    console.log(
      `GW${k}: MAE model ${r2(mae(e1))} vs PPG ${r2(mae(e2))} | captain ${capModel.webName} ${actualPoints(hist, capModel.id, k)} vs ${capBase.webName} ${actualPoints(hist, capBase.id, k)} | squad model ${sm.pts} (pred ${r2(sm.predicted)}) vs PPG ${sb.pts}`,
    );
  }

  const result = {
    generatedAt: new Date().toISOString(),
    gameweeks: perGw.map((g) => g.gw),
    sample: err.model.length,
    model: { mae: r2(mae(err.model)), rmse: r2(rmse(err.model)), bias: r2(avg(err.model)) },
    baseline: { mae: r2(mae(err.base)), rmse: r2(rmse(err.base)), bias: r2(avg(err.base)) },
    captain: {
      modelAvgPoints: r2(avg(perGw.map((g) => g.captainModel.points))),
      baselineAvgPoints: r2(avg(perGw.map((g) => g.captainBaseline.points))),
      bestPossibleAvg: r2(avg(perGw.map((g) => g.captainBestPossible))),
      hitRate: r2(perGw.filter((g) => g.captainModel.points >= g.captainBaseline.points).length / perGw.length),
    },
    squad: {
      modelAvg: r2(avg(perGw.map((g) => g.squadModel.actual))),
      baselineAvg: r2(avg(perGw.map((g) => g.squadBaseline.actual))),
      modelPredictedAvg: r2(avg(perGw.map((g) => g.squadModel.predicted))),
    },
    perGw,
    notes: [
      "Point-in-time: features use only rounds before the target gameweek; prices are the price after the previous gameweek.",
      "Availability news is not point-in-time in the public API, so all players are treated as available for both model and baseline.",
      "Error metrics cover players with >= 270 prior minutes and a fixture in the gameweek.",
      "Baseline = season points-per-game x number of fixtures; baseline squad is optimised on the same constraints.",
      "Squad points use actual points of the chosen XI + captain x2, without automatic substitutions.",
    ],
  };
  await fs.writeFile(path.join(process.cwd(), "docs", "backtest-results.json"), JSON.stringify(result, null, 2));
  console.log("\nSummary", JSON.stringify({ model: result.model, baseline: result.baseline, captain: result.captain, squad: result.squad }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
