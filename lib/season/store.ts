import type { SeasonState } from "./types";

const KEY = "fpl-intelligence:season:v1";

/** Browser persistence for the season (single manager, no accounts). Everything is JSON-serialisable. */
export function loadSeason(): SeasonState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SeasonState;
    return s?.version === 1 && s.actual?.holdings ? s : null;
  } catch {
    return null;
  }
}

export function saveSeason(s: SeasonState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
  } catch {
    /* storage unavailable: the in-memory state still works for this session */
  }
}

export function clearSeason() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Merge real FPL points into snapshots made earlier (predictions are never overwritten). */
export function withActuals(s: SeasonState): SeasonState {
  return {
    ...s,
    snapshots: s.snapshots.map((sn) => {
      const h = s.actualHistory.find((x) => x.event === sn.gw);
      return h && sn.actualPoints === undefined ? { ...sn, actualPoints: h.points - h.transferCost } : sn;
    }),
  };
}
