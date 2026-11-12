// Downloads FIXED snapshots of public historical FPL data (vaastav/Fantasy-Premier-League) and records SHA-256 hashes.
//
//   node scripts/backtest/fetch-historical.mjs            first run: fetches `master` and writes the manifest (pins the commit)
//                                                          later runs: re-fetches the PINNED commit from the manifest and verifies hashes
//   node scripts/backtest/fetch-historical.mjs --check    download the pinned files to memory and compare hashes; writes nothing
//   node scripts/backtest/fetch-historical.mjs --refresh  move to the current upstream master (new commit, new hashes: results will change)
//
// The backtest itself reads only the stored gzip files and never touches the network.
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"];
const FILES = ["gws/merged_gw.csv", "fixtures.csv", "teams.csv"];
const MANIFEST = "data/historical/manifest.json";
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const refresh = args.has("--refresh");
const old = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;

let commit = !refresh && old?.commit ? old.commit : null;
let commitDate = old?.commitDate ?? null;
if (!commit) {
  const c = await (await fetch("https://api.github.com/repos/vaastav/Fantasy-Premier-League/commits/master", { headers: { "user-agent": "fpl-intelligence-backtest" } })).json();
  commit = c.sha;
  commitDate = c.commit?.committer?.date ?? null;
  if (!commit) throw new Error("could not resolve the upstream commit; refusing to fetch an unpinned ref");
}
const RAW = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/${commit}/data`;
const manifest = { source: "https://github.com/vaastav/Fantasy-Premier-League", fetchedAt: new Date().toISOString(), commit, commitDate, files: [] };
let bad = 0;
for (const s of SEASONS) {
  if (!check) mkdirSync(`data/historical/${s}`, { recursive: true });
  for (const f of FILES) {
    const url = `${RAW}/${s}/${f}`;
    const res = await fetch(url);
    if (!res.ok) { console.log("MISSING", url, res.status); manifest.files.push({ season: s, file: f, missing: res.status }); bad++; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const prev = old?.files.find((x) => x.season === s && x.file === f);
    const same = prev?.sha256 === sha256;
    if (prev && !refresh && !same) { console.log("HASH MISMATCH", s, f); bad++; }
    if (!check) {
      const stored = `data/historical/${s}/${f.split("/").pop()}.gz`;
      writeFileSync(stored, gzipSync(buf, { level: 9 }));
      manifest.files.push({ season: s, file: f, url, bytes: buf.length, sha256, stored });
    }
    console.log(check || prev ? (same ? "verified " : "DIFFERS  ") : "fetched  ", s, f, buf.length);
  }
}
if (!check) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`upstream commit ${commit}`);
if (bad) { console.error(`${bad} problem(s)`); process.exit(1); }
