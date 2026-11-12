/**
 * Generates the Balanced Plus Gameweek Intelligence Report (PDF + JSON) from the live FPL data snapshot.
 *   npx tsx scripts/balanced-plus.ts [gw]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getDataset } from "../lib/fpl/client";
import { nextGameweek } from "../lib/fpl/normalizer";
import { buildHorizon } from "../lib/season/horizon";
import { buildBalancedPlusDoc } from "../lib/strategies/report";

async function main() {
  const ds = await getDataset();
  const gw = Number(process.argv[2]) || nextGameweek(ds.events).id;
  const doc = await buildBalancedPlusDoc(ds, gw, buildHorizon(ds, gw));
  const pdf = await doc.pdf();
  mkdirSync("docs/samples", { recursive: true });
  const file = `docs/samples/gw${gw}-balanced-plus-report.pdf`;
  writeFileSync(file, pdf);
  writeFileSync(`docs/samples/gw${gw}-balanced-plus-comparison.json`, JSON.stringify({ gw, fetchedAt: ds.fetchedAt, source: ds.source, strategy: doc.definition, comparison: doc.comparison }, null, 2));
  console.log(`wrote ${file} (${(pdf.length / 1024).toFixed(0)} KB) from data fetched ${ds.fetchedAt} (${ds.source})`);
  console.log(doc.comparison.metrics.map((m) => `${m.label.padEnd(14)} GW${gw} ${m.gw0Xpts.toFixed(2)}  5GW ${m.fiveGwXpts.toFixed(2)}  maxClubXI ${m.maxClubInXI}`).join("\n"));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
