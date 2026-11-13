import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HORIZON_WEIGHTS } from "../season/horizon";
import { BALANCED_PLUS } from "../strategies/balancedPlus";

const FROZEN_FILE = path.join(process.cwd(), "data", "backtest-frozen.json");

/** Files whose behaviour defines the four strategies. If any changes, the backtest refuses to run unless re-frozen on purpose. */
export function strategySourceFiles(): string[] {
  const list: string[] = [];
  for (const dir of ["lib/optimizer", "lib/analytics"]) for (const f of readdirSync(path.join(process.cwd(), dir))) if (f.endsWith(".ts")) list.push(`${dir}/${f}`);
  list.push("lib/strategies/balancedPlus.ts");
  return list.sort();
}

export function sourceHashes(): Record<string, string> {
  return Object.fromEntries(strategySourceFiles().map((f) => [f, createHash("sha256").update(readFileSync(path.join(process.cwd(), f))).digest("hex")]));
}

export function currentConfig() {
  return {
    balancedPlusParameters: { ...BALANCED_PLUS, benchTargets: [...BALANCED_PLUS.benchTargets] },
    horizonWeights: [...HORIZON_WEIGHTS],
    windowLength: 5,
    squadBudgetTenths: 1000,
    sourceHashes: sourceHashes(),
  };
}

/** Writes the freeze record on first use; afterwards verifies nothing changed. Returns the record. */
export function freezeOrVerify(force = false): { frozenAt: string; config: ReturnType<typeof currentConfig>; verified: boolean } {
  const cfg = currentConfig();
  if (!existsSync(FROZEN_FILE) || force) {
    const rec = { frozenAt: new Date().toISOString(), note: "Strategy code and parameters at the moment the held-out evaluation was first run. No parameter was tuned.", config: cfg };
    writeFileSync(FROZEN_FILE, JSON.stringify(rec, null, 2));
    return { ...rec, verified: true };
  }
  const rec = JSON.parse(readFileSync(FROZEN_FILE, "utf8"));
  const same = JSON.stringify(rec.config) === JSON.stringify(cfg);
  if (!same) {
    const diff = Object.keys(cfg.sourceHashes).filter((f) => cfg.sourceHashes[f] !== rec.config.sourceHashes[f]);
    throw new Error(`Strategy code/parameters changed since the freeze (${rec.frozenAt}): ${diff.join(", ") || "parameters"}. Re-run with FORCE_REFREEZE=1 only if the change is deliberate and documented.`);
  }
  return { frozenAt: rec.frozenAt, config: cfg, verified: true };
}

/* ---------------- Season Long: a separate freeze record (the Balanced Plus freeze above is untouched) ---------------- */
import { SEASON_LONG } from "../strategies/seasonLong";

const FROZEN_SL_FILE = path.join(process.cwd(), "data", "backtest-frozen-season-long.json");

export function seasonLongConfig() {
  const files = [...strategySourceFiles(), "lib/strategies/seasonLong.ts"].sort();
  return {
    seasonLongParameters: { ...SEASON_LONG, recoveryTau: { ...SEASON_LONG.recoveryTau } },
    windowLengths: [5, 10],
    sourceHashes: Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.join(process.cwd(), f))).digest("hex")])),
  };
}

export function freezeOrVerifySeasonLong(force = false) {
  const cfg = seasonLongConfig();
  if (!existsSync(FROZEN_SL_FILE) || force) {
    const rec = { frozenAt: new Date().toISOString(), note: "Season Long code and parameters when the held-out evaluation was first run. Parameters were calibrated on the development season (2023-24) only.", config: cfg };
    writeFileSync(FROZEN_SL_FILE, JSON.stringify(rec, null, 2));
    return { ...rec, verified: true };
  }
  const rec = JSON.parse(readFileSync(FROZEN_SL_FILE, "utf8"));
  if (JSON.stringify(rec.config) !== JSON.stringify(cfg)) {
    const diff = Object.keys(cfg.sourceHashes).filter((f) => cfg.sourceHashes[f] !== rec.config.sourceHashes[f]);
    throw new Error(`Season Long code/parameters changed since the freeze (${rec.frozenAt}): ${diff.join(", ") || "parameters"}. Re-run with FORCE_REFREEZE=1 only if deliberate and documented.`);
  }
  return { frozenAt: rec.frozenAt, config: cfg, verified: true };
}
