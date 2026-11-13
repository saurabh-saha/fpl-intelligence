import type { Snapshot, SeasonState } from "./types";

/**
 * Local recovery history for "Lock in & advance". Everything here is local to FPL Intelligence: it never
 * talks to the FPL API and cannot change the official team.
 */
export const MAX_LOCK_HISTORY = 5;

export interface LockRecord {
  gw: number; // the gameweek that was locked in
  lockedAt: string; // ISO timestamp
  /** the state exactly as it was before the lock-in */
  prev: Pick<SeasonState, "actual" | "plans" | "snapshots" | "recs">;
  /** fingerprint of the actual squad the lock-in produced; rollback is refused if it has since changed */
  afterActual: string;
  /** set when the squad was re-synced from FPL after this lock-in: kept for display, no longer undoable */
  stale?: boolean;
}

const fp = (a: SeasonState["actual"]) => JSON.stringify(a);
export const history = (s: Pick<SeasonState, "lockHistory"> | null | undefined): LockRecord[] => (Array.isArray(s?.lockHistory) ? s!.lockHistory! : []);

/** The record that Undo would apply, or null (nothing to undo, stale after a re-sync, or the actual squad changed since). */
export function undoableLock(s: SeasonState): LockRecord | null {
  const last = history(s)[0];
  if (!last || last.stale) return null;
  return fp(s.actual) === last.afterActual ? last : null;
}

export function whyNotUndoable(s: SeasonState): string {
  const last = history(s)[0];
  if (!last) return "No recent lock-in to undo.";
  if (last.stale) return "The squad was re-synced from FPL after the last lock-in, so it can no longer be undone.";
  return "The actual squad was edited after the last lock-in, so it can no longer be undone.";
}

/** Apply a successful commit: advance the state and record how to get back. Pure; call only after the API succeeded. */
export function applyLock(s: SeasonState, gw: number, newActual: SeasonState["actual"], snapshot: Snapshot, now = new Date().toISOString()): SeasonState {
  const plans = { ...s.plans };
  delete plans[gw];
  const record: LockRecord = {
    gw,
    lockedAt: now,
    prev: { actual: s.actual, plans: s.plans, snapshots: s.snapshots, recs: s.recs },
    afterActual: fp(newActual),
  };
  return {
    ...s,
    actual: newActual,
    plans,
    snapshots: [...s.snapshots.filter((x) => x.gw !== gw), snapshot].sort((a, b) => a.gw - b.gw),
    lockHistory: [record, ...history(s)].slice(0, MAX_LOCK_HISTORY),
  };
}

/** Run the commit and apply it atomically: on failure the state is returned untouched and no record is created. */
export async function commitLock(
  s: SeasonState,
  gw: number,
  commit: () => Promise<{ newActual: SeasonState["actual"]; snapshot: Snapshot }>,
): Promise<{ state: SeasonState; error?: string }> {
  try {
    const r = await commit();
    return { state: applyLock(s, gw, r.newActual, r.snapshot) };
  } catch (e) {
    return { state: s, error: (e as Error).message };
  }
}

/** Restore the state from before the most recent lock-in and consume its record. Returns null if not allowed. */
export function undoLastLock(s: SeasonState): SeasonState | null {
  const rec = undoableLock(s);
  if (!rec) return null;
  return { ...s, ...rec.prev, lockHistory: history(s).slice(1) };
}

/** After a re-sync from FPL the official squad is newer than any recovery point: keep the entries, forbid rollback. */
export function markResynced(list: LockRecord[] | undefined): LockRecord[] {
  return (list ?? []).map((r) => ({ ...r, stale: true }));
}
