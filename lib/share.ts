/** Stateless share links: the squad is encoded in the URL so no accounts or database are needed. */
export interface SharePayload {
  /** gameweek the squad was built for */
  gw: number;
  /** 11 starters then 4 bench, in display order */
  ids: number[];
  captain: number;
  vice: number;
  /** optional user-given squad name */
  name?: string;
  mode?: string;
}

const toB64Url = (s: string) =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64Url = (s: string) =>
  decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export function encodeShare(p: SharePayload): string {
  return toB64Url(JSON.stringify([p.gw, p.ids, p.captain, p.vice, p.name ?? "", p.mode ?? ""]));
}

export function decodeShare(d: string): SharePayload | null {
  try {
    const [gw, ids, captain, vice, name, mode] = JSON.parse(fromB64Url(d));
    if (!Number.isInteger(gw) || !Array.isArray(ids) || ids.length !== 15 || !ids.every(Number.isInteger)) return null;
    if (!Number.isInteger(captain) || !Number.isInteger(vice)) return null;
    return { gw, ids, captain, vice, name: String(name ?? "").slice(0, 60) || undefined, mode: mode || undefined };
  } catch {
    return null;
  }
}
