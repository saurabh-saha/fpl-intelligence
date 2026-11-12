import { readFileSync } from "node:fs";
import path from "node:path";

export type Verdict = "advantage" | "no-advantage-established" | "underperforms" | "insufficient-data";

/** Short, user-visible limitations of the historical validation. Shown in the UI, the PDF and (in long form) docs/BALANCED_PLUS_BACKTEST.md. */
export const BACKTEST_LIMITATIONS: string[] = [
  "Only two held-out seasons (12 independent five-gameweek windows): differences smaller than about 6 points per gameweek cannot be detected.",
  "No point-in-time injury or availability news exists; a past-minutes proxy is used for every strategy.",
  "One squad is held for five gameweeks (no transfers, chips or price changes), so season-long play is not tested.",
  "Fixtures are the final schedule and prices are up to a week stale; the source is a third-party scrape assumed accurate.",
  "2022-23 was excluded (the source lacks starts and xG for the first gameweeks); 2026-27 has too few gameweeks.",
  "The strategy's parameters were not tuned on any window, but its ideas were designed with prior FPL knowledge; sensitivity results are exploratory.",
];

export interface ValidationSummary {
  available: boolean;
  verdict?: Verdict;
  verdictText?: string;
  headline?: string;
  lines?: string[];
  limitations?: string[];
}

/**
 * Reads the committed backtest results (docs/backtest) and states the conclusion with the same rule the backtest report
 * uses: an advantage is claimed only if BOTH 95% intervals (t on non-overlapping windows, block bootstrap on all windows)
 * exclude zero on the pooled held-out seasons AND the sign is the same in each held-out season.
 */
export function loadValidationSummary(file = path.join(process.cwd(), "docs", "backtest", "balanced-plus-backtest-results.json")): ValidationSummary {
  let r: any;
  try {
    r = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { available: false };
  }
  const pooled = r.evaluation?.pooled;
  const p = pooled?.pairedVsBaseline?.["balanced-plus"];
  if (!p) return { available: false };
  const seasons: Record<string, any> = r.evaluation.perSeason ?? {};
  const signs = Object.entries(seasons).map(([s, v]: [string, any]) => ({ season: s, diff: v.pairedVsBaseline?.["balanced-plus"]?.meanDiff as number }));
  const consistent = signs.length > 0 && signs.every((x) => Math.sign(x.diff) === Math.sign(p.meanDiff));
  let verdict: Verdict;
  if (p.nNonOverlapping < 8) verdict = "insufficient-data";
  else if (p.evidence === "advantage" && consistent) verdict = "advantage";
  else if (p.evidence === "disadvantage") verdict = "underperforms";
  else verdict = "no-advantage-established";
  const text: Record<Verdict, string> = {
    advantage: "Balanced Plus demonstrates a measurable advantage over Balanced.",
    "no-advantage-established": "Balanced Plus is competitive, but no advantage over Balanced is established.",
    underperforms: "Balanced Plus underperforms Balanced.",
    "insufficient-data": "Insufficient historical data to reach a conclusion.",
  };
  const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);
  const lines = [
    `Held-out seasons ${Object.keys(seasons).join(" and ")}: ${p.nWindows} rolling five-gameweek windows (${p.nNonOverlapping} non-overlapping).`,
    `Balanced Plus minus Balanced: mean ${fmt(p.meanDiff)} points per window (median ${fmt(p.medianDiff)}, SD ${p.sdDiff.toFixed(1)}); 95% CI ${fmt(p.tCI95NonOverlapping[0])} to ${fmt(p.tCI95NonOverlapping[1])} (t, non-overlapping) and ${fmt(p.blockBootstrapCI95[0])} to ${fmt(p.blockBootstrapCI95[1])} (block bootstrap).`,
    `By season: ${signs.map((x) => `${x.season} ${fmt(x.diff)}`).join(", ")}. Development season 2023-24: ${fmt(r.development?.pairedVsBaseline?.["balanced-plus"]?.meanDiff ?? NaN)} (not used as evidence).`,
  ];
  return { available: true, verdict, verdictText: text[verdict], headline: `${text[verdict]} (${r.evaluation.pooled.windows} held-out windows)`, lines, limitations: BACKTEST_LIMITATIONS };
}
