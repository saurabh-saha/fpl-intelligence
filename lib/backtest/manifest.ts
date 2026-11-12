import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export interface ManifestFile { season: string; file: string; url?: string; bytes?: number; sha256?: string; stored?: string; missing?: number }
export interface Manifest { source: string; fetchedAt: string; commit: string | null; commitDate?: string | null; files: ManifestFile[] }

export const MANIFEST_PATH = path.join(process.cwd(), "data", "historical", "manifest.json");

export const readManifest = (): Manifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

/** Re-hashes every stored snapshot (after gunzip) against the manifest. Returns the files that are missing or differ. */
export function verifyHistoricalManifest(): { commit: string | null; checked: number; bad: string[] } {
  const m = readManifest();
  const bad: string[] = [];
  let checked = 0;
  for (const f of m.files) {
    if (f.missing || !f.stored) continue;
    const file = path.join(process.cwd(), f.stored);
    if (!existsSync(file)) { bad.push(`${f.stored} (missing)`); continue; }
    const h = createHash("sha256").update(gunzipSync(readFileSync(file))).digest("hex");
    checked++;
    if (h !== f.sha256) bad.push(f.stored);
  }
  return { commit: m.commit, checked, bad };
}
