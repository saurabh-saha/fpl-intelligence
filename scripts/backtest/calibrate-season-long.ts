/**
 * Calibrates the two free Season Long projection parameters on the DEVELOPMENT season only (2023-24):
 *   fixtureTrust (rho)  - weight on the specific opponent at lead j (the rest goes to the player's average fixture)
 *   futureAbsence (h)   - extra availability haircut on fit players at distance
 * Criteria (long lead times, 5-20 gameweeks ahead, players with >= 270 prior minutes, information available at each deadline only):
 *   futureAbsence: the value that makes the projection UNBIASED against actual points (an expected-points model must be calibrated;
 *                  MAE is not used here because most player-gameweeks score 0-2 points, so MAE rewards shrinking every projection
 *                  well below the mean, which would make the numbers worse expected values).
 *   fixtureTrust:  lowest MAE at that futureAbsence.
 * The held-out seasons are never read here.
 *   npx tsx scripts/backtest/calibrate-season-long.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadSeason, pointInTime } from "../../lib/backtest/historical";
import { mean } from "../../lib/backtest/stats";
import { buildSeasonHorizon } from "../../lib/strategies/seasonLong";

const SEASON = "2023-24";
const KS = [8, 12, 16, 20, 24];
const RHO = [1, 0.96];
const H = [0, 0.05, 0.1, 0.12, 0.15, 0.2, 0.25];
const BUCKETS: [string, number, number][] = [["lead 0-4", 0, 4], ["lead 5-9", 5, 9], ["lead 10-14", 10, 14], ["lead 15-20", 15, 20]];

function main() {
  const sd = loadSeason(SEASON);
  const dsAt = new Map(KS.map((k) => [k, pointInTime(sd, k)]));
  const rows: { rho: number; h: number; mae: Record<string, number>; bias: Record<string, number>; maeLong: number; n: number }[] = [];
  for (const rho of RHO) for (const h of H) {
    const errs: Record<string, number[]> = {};
    const bias: Record<string, number[]> = {};
    for (const k of KS) {
      const ds = dsAt.get(k)!;
      const hz = buildSeasonHorizon(ds, k, { endGw: Math.min(38, k + 20), params: { fixtureTrust: rho, futureAbsence: h } });
      const eligible = ds.players.filter((p) => p.minutes >= 270);
      hz.gws.forEach((g, j) => {
        const b = BUCKETS.find(([, lo, hi]) => j >= lo && j <= hi)![0];
        const act = sd.actual.get(g);
        if (!act) return;
        for (const p of eligible) {
          const pr = hz.proj[j].get(p.id)!;
          if (pr.fixtures.length === 0) continue;
          const a = act.get(p.id)?.points ?? 0;
          (errs[b] ??= []).push(Math.abs(pr.ep - a));
          (bias[b] ??= []).push(pr.ep - a);
        }
      });
    }
    const mae = Object.fromEntries(BUCKETS.map(([b]) => [b, mean(errs[b])]));
    const long = [...(errs["lead 5-9"] ?? []), ...(errs["lead 10-14"] ?? []), ...(errs["lead 15-20"] ?? [])];
    rows.push({ rho, h, mae, bias: Object.fromEntries(BUCKETS.map(([b]) => [b, mean(bias[b])])), maeLong: mean(long), n: long.length });
    console.log(`rho ${String(rho).padEnd(4)} h ${String(h).padEnd(4)} MAE ${BUCKETS.map(([b]) => `${b} ${mae[b].toFixed(4)}`).join(" | ")} | long(5-20) ${mean(long).toFixed(4)} bias(long) ${mean([...(bias["lead 5-9"] ?? []), ...(bias["lead 10-14"] ?? []), ...(bias["lead 15-20"] ?? [])]).toFixed(3)}`);
  }
  const longBias = (r: (typeof rows)[number]) => (r.bias["lead 5-9"] + r.bias["lead 10-14"] + r.bias["lead 15-20"]) / 3;
  const hBest = [...new Set(rows.map((r) => r.h))].sort((a, b) => Math.abs(longBias(rows.find((r) => r.h === a)!)) - Math.abs(longBias(rows.find((r) => r.h === b)!)))[0];
  const best = rows.filter((r) => r.h === hBest).sort((a, b) => a.maeLong - b.maeLong)[0];
  console.log(`\nchosen on the development season: futureAbsence ${best.h} (long-lead bias ${longBias(best).toFixed(3)}), fixtureTrust ${best.rho} (lowest MAE at that haircut ${best.maeLong.toFixed(4)})`);
  mkdirSync("docs/backtest", { recursive: true });
  writeFileSync("docs/backtest/season-long-calibration.json", JSON.stringify({ season: SEASON, gameweeksSampled: KS, criterion: "futureAbsence = zero long-lead bias; fixtureTrust = lowest long-lead MAE at that haircut (players with >= 270 prior minutes, leads 5-20)", grid: rows, best: { fixtureTrust: best.rho, futureAbsence: best.h } }, null, 1));
}
main();
