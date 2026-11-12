/** Verifies the frozen historical snapshots against data/historical/manifest.json (no network). */
import { verifyHistoricalManifest } from "../../lib/backtest/manifest";

const r = verifyHistoricalManifest();
console.log(`${r.checked} files checked against upstream commit ${r.commit}`);
if (r.bad.length) { console.error("MISMATCH:", r.bad.join(", ")); process.exit(1); }
console.log("all snapshot hashes match");
