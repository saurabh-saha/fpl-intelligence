import type { PlayerView, SquadView } from "./api";
import type { Mode } from "./fpl/types";

export type { PlayerView, SquadView };

export interface Meta {
  currentGw: number | null;
  nextGw: number;
  events: { id: number; name: string; deadline: string; finished: boolean; isCurrent: boolean; isNext: boolean }[];
  teams: { id: number; name: string; short: string; badgeUrl: string; played: number }[];
  fetchedAt: string;
  source: "live" | "cache" | "sample";
  stale: boolean;
}

export interface Prefs {
  mode: Mode;
  budget?: number;
  formation?: string;
  differential?: number;
  maxOwnership?: number;
  favourFixtureRuns?: boolean;
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/* ---- saved squads (local persistence, no accounts needed) ---- */

export interface SavedSquad {
  id: string;
  name: string;
  gw: number;
  mode: Mode;
  ids: number[];
  captain: number;
  vice: number;
  ep: number;
  createdAt: string;
}

const KEY = "fpl-intelligence:saved:v1";

export function loadSaved(): SavedSquad[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveSquad(s: Omit<SavedSquad, "id" | "createdAt">): SavedSquad {
  const entry: SavedSquad = { ...s, id: Math.random().toString(36).slice(2, 10), createdAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify([entry, ...loadSaved()].slice(0, 50)));
  } catch {
    /* storage unavailable: the squad is still shareable via URL */
  }
  return entry;
}

export function deleteSaved(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadSaved().filter((s) => s.id !== id)));
  } catch {
    /* ignore */
  }
}

export const fmtGbp = (n: number) => `£${n.toFixed(1)}m`;
export const signed = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;

/**
 * Download the Gameweek Intelligence Report (PDF) for the squad currently on screen.
 * The squad is sent as displayed; the server validates it but never regenerates it.
 */
export async function downloadGwReport(body: unknown): Promise<{ filename: string; bytes: number; squad: string }> {
  const res = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? `Report failed (${res.status})`);
  }
  const blob = await res.blob();
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "fpl-gw-report.pdf";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, bytes: blob.size, squad: res.headers.get("x-report-squad") ?? "" };
}
