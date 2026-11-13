import { beforeEach, describe, expect, it } from "vitest";
import { MAX_LOCK_HISTORY, applyLock, commitLock, history, markResynced, undoLastLock, undoableLock, whyNotUndoable } from "@/lib/season/lockHistory";
import { clearSeason, loadSeason, saveSeason } from "@/lib/season/store";
import type { SeasonState, Snapshot } from "@/lib/season/types";
import { mediocreSquad, stateOf } from "./seasonHelpers";

const KEY = "fpl-intelligence:season:v1";
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0 } as Storage;

const snap = (gw: number): Snapshot => ({ gw, squadIds: [1, 2], captain: 1, vice: 2, chip: null, transfers: [], hitCost: 0, predictedEp: 50, lockedAt: "t" } as unknown as Snapshot);
const base = (): SeasonState => ({ ...stateOf(mediocreSquad()), recs: [{ gw: 11 } as never], plans: { 11: { transfers: [], chip: null } as never, 12: { transfers: [], chip: null } as never } });
const next = (s: SeasonState, gw = s.actual.gw) => ({ ...s.actual, gw: gw + 1, freeTransfers: 2 });
const lock = (s: SeasonState, at = "2026-11-14T10:00:00Z") => applyLock(s, s.actual.gw, next(s), snap(s.actual.gw), at);

beforeEach(() => mem.clear());

describe("lock-in recovery history", () => {
  it("1. a successful lock-in creates a recovery record", async () => {
    const s = base();
    const r = await commitLock(s, 11, async () => ({ newActual: next(s), snapshot: snap(11) }));
    expect(r.error).toBeUndefined();
    expect(r.state.actual.gw).toBe(12);
    const [rec] = history(r.state);
    expect(rec).toMatchObject({ gw: 11, prev: { actual: s.actual, plans: s.plans, snapshots: s.snapshots, recs: s.recs } });
    expect(Number.isNaN(Date.parse(rec.lockedAt))).toBe(false);
    expect(r.state.plans[11]).toBeUndefined();
  });
  it("2. a failed commit creates no record and leaves the state untouched", async () => {
    const s = base();
    const r = await commitLock(s, 11, async () => { throw new Error("Plan is not legal"); });
    expect(r.error).toMatch(/not legal/);
    expect(r.state).toBe(s);
    expect(history(r.state)).toHaveLength(0);
  });
  it("3+4. undo restores the exact prior state and the previous gameweek", () => {
    const s = base();
    const locked = lock(s);
    const back = undoLastLock(locked)!;
    expect(back.actual).toEqual(s.actual);
    expect(back.actual.gw).toBe(11);
    expect(back.plans).toEqual(s.plans);
    expect(back.snapshots).toEqual(s.snapshots);
    expect(back.recs).toEqual(s.recs);
    expect(JSON.parse(JSON.stringify({ ...back, lockHistory: undefined }))).toEqual(JSON.parse(JSON.stringify({ ...s, lockHistory: undefined })));
  });
  it("5+6. undo consumes the record and cannot be applied twice", () => {
    const locked = lock(base());
    const back = undoLastLock(locked)!;
    expect(history(back)).toHaveLength(0);
    expect(undoLastLock(back)).toBeNull();
    expect(undoableLock(back)).toBeNull();
    expect(whyNotUndoable(back)).toBe("No recent lock-in to undo.");
  });
  it("undoes successive lock-ins one at a time, newest first", () => {
    const s0 = base();
    const s1 = lock(s0);
    const s2 = lock(s1);
    const u1 = undoLastLock(s2)!;
    expect(u1.actual.gw).toBe(12);
    expect(u1.actual).toEqual(s1.actual);
    expect(undoLastLock(u1)!.actual.gw).toBe(11);
  });
  it("7. records saved before lock history existed load unchanged and gain nothing destructive", () => {
    const legacy = base();
    mem.set(KEY, JSON.stringify(legacy));
    const loaded = loadSeason()!;
    expect(loaded.actual).toEqual(legacy.actual);
    expect(loaded.plans).toEqual(legacy.plans);
    expect(history(loaded)).toEqual([]);
    expect(undoableLock(loaded)).toBeNull();
    saveSeason(loaded);
    expect(JSON.parse(mem.get(KEY)!).actual).toEqual(legacy.actual);
    mem.set(KEY, JSON.stringify({ ...legacy, lockHistory: "garbage" }));
    expect(history(loadSeason()!)).toEqual([]);
  });
  it("persists history through Local Storage", () => {
    const locked = lock(base());
    saveSeason(locked);
    const loaded = loadSeason()!;
    expect(history(loaded)).toHaveLength(1);
    expect(undoLastLock(loaded)!.actual.gw).toBe(11);
  });
  it("8. history is capped at 5 entries, newest first", () => {
    let s = base();
    for (let i = 0; i < 8; i++) s = lock(s);
    expect(history(s)).toHaveLength(MAX_LOCK_HISTORY);
    expect(history(s).map((r) => r.gw)).toEqual([18, 17, 16, 15, 14]);
    saveSeason(s);
    expect(history(loadSeason()!)).toHaveLength(5);
  });
  it("9. after a re-sync from FPL, an old lock-in can no longer overwrite the official squad", () => {
    const locked = lock(base());
    const official = { ...locked.actual, bankTenths: locked.actual.bankTenths + 7 };
    const synced: SeasonState = { ...locked, actual: official, lockHistory: markResynced(locked.lockHistory) };
    expect(history(synced)).toHaveLength(1); // still shown
    expect(undoableLock(synced)).toBeNull();
    expect(undoLastLock(synced)).toBeNull();
    expect(whyNotUndoable(synced)).toMatch(/re-synced/);
    // even an identical re-synced squad stays protected
    expect(undoLastLock({ ...locked, lockHistory: markResynced(locked.lockHistory) })).toBeNull();
  });
  it("refuses to roll back when the actual squad was edited after the lock-in", () => {
    const locked = lock(base());
    const edited = { ...locked, actual: { ...locked.actual, freeTransfers: 5 } };
    expect(undoLastLock(edited)).toBeNull();
    expect(whyNotUndoable(edited)).toMatch(/edited/);
  });
  it("10. resetting the season clears the recovery history", () => {
    saveSeason(lock(base()));
    expect(mem.has(KEY)).toBe(true);
    clearSeason();
    expect(loadSeason()).toBeNull();
    expect(mem.has(KEY)).toBe(false);
  });
});
