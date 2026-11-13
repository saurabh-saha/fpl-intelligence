import { buildModelContext, projectPlayer, type ModelContext } from "../analytics/expectedPoints";
import type { Dataset, Player, Projection } from "../fpl/types";
import { adjustAvailability, type AvailabilityResult } from "./availability";
import { buildEvents } from "./events";
import { SOURCE_RELIABILITY } from "./sources";
import type { NewsEvent, NewsImpact, NewsState } from "./types";

/**
 * The bridge between news events and the (unchanged) expected-points model.
 * News only changes the availability input; the model computes the points.
 */
export class NewsOverlay {
  readonly byPlayer = new Map<number, NewsEvent[]>();
  constructor(public readonly events: NewsEvent[], public readonly now: Date, readonly version: string) {
    for (const e of events) if (e.active) this.byPlayer.set(e.playerId, [...(this.byPlayer.get(e.playerId) ?? []), e]);
  }
  get size() { return this.byPlayer.size; }
  has(playerId: number) { return this.byPlayer.has(playerId); }

  adjust(p: Player, ds: Dataset, ctx: ModelContext, gw: number): AvailabilityResult | null {
    const evs = this.byPlayer.get(p.id);
    if (!evs) return null;
    return adjustAvailability({ player: p, team: ds.teams[p.teamId], gw, nextId: ctx.nextId, kickoff: kickoffFor(ds, p.teamId, gw), events: evs, now: this.now });
  }
}

export function buildOverlay(state: NewsState | null | undefined, now = new Date()): NewsOverlay | null {
  if (!state?.items.length) return null;
  const events = buildEvents(state.items, SOURCE_RELIABILITY, now).filter((e) => e.active);
  if (!events.length) return null;
  const version = `${state.lastSuccessAt ?? "none"}:${events.length}:${now.toISOString().slice(0, 13)}`;
  return new NewsOverlay(events, now, version);
}

/** Kickoff of the team's first match in a gameweek (falls back to that gameweek's deadline). */
export function kickoffFor(ds: Dataset, teamId: number, gw: number): Date {
  const ks = ds.fixtures.filter((f) => f.event === gw && (f.teamH === teamId || f.teamA === teamId) && f.kickoff).map((f) => Date.parse(f.kickoff!)).sort((a, b) => a - b);
  if (ks.length) return new Date(ks[0]);
  const ev = ds.events.find((e) => e.id === gw);
  return new Date(ev?.deadline ? Date.parse(ev.deadline) + 86_400_000 : Date.now());
}

function impactOf(p: Player, gw: number, base: Projection, adjusted: Projection, adj: AvailabilityResult, overlay: NewsOverlay): NewsImpact {
  const ids = new Set(adj.supportingNewsIds);
  const src = new Map<string, NewsImpact["sources"][number]>();
  for (const e of overlay.byPlayer.get(p.id) ?? []) for (const i of e.items) if (ids.has(i.id)) src.set(i.sourceUrl, { name: i.sourceName, url: i.sourceUrl, publishedAt: i.publishedAt, status: i.status });
  return {
    playerId: p.id, gw,
    baseXpts: base.ep, newsAdjustedXpts: adjusted.ep,
    baseStartProbability: adj.baseStartProbability, adjustedStartProbability: adj.adjustedStartProbability,
    baseExpectedMinutes: adj.baseExpectedMinutes, adjustedExpectedMinutes: adj.adjustedExpectedMinutes,
    availabilityStatus: adj.availabilityStatus, availabilityConfidence: adj.availabilityConfidence,
    reasonCodes: adj.reasonCodes, adjustmentReasons: adj.reasons, supportingNewsIds: adj.supportingNewsIds,
    sources: [...src.values()],
  };
}

/** The player's projection for `g`. With no relevant news this is EXACTLY projectPlayer(p, ctx, g). */
export function newsProject(p: Player, ctx: ModelContext, g: number, overlay: NewsOverlay | null | undefined): Projection {
  const base = projectPlayer(p, ctx, g);
  if (!overlay) return base;
  const adj = overlay.adjust(p, ctx.ds, ctx, g);
  if (!adj) return base;
  const patched: Player = { ...p, chanceNext: adj.engineAvailability * 100, status: ["u", "s", "n"].includes(p.status) ? "a" : p.status };
  const adjusted = projectPlayer(patched, { ...ctx, nextId: g }, g);
  const news = impactOf(p, g, base, adjusted, adj, overlay);
  return { ...adjusted, news, warnings: [...adjusted.warnings, ...adj.reasons.slice(0, 2).map((r) => `News: ${r}`)] };
}

/**
 * Dataset copy in which affected players carry the news-adjusted availability for `gw`, so that the frozen
 * single-gameweek strategy code (Balanced, Safe, Aggressive, Balanced Plus) consumes news without being modified.
 * Returns the SAME dataset object when there is nothing to apply.
 */
export function applyNewsToDataset(ds: Dataset, gw: number, overlay: NewsOverlay | null | undefined): { ds: Dataset; impacts: Map<number, NewsImpact> } {
  const impacts = new Map<number, NewsImpact>();
  if (!overlay || overlay.size === 0) return { ds, impacts };
  const ctx = buildModelContext(ds, gw);
  const patch = new Map<number, Player>();
  for (const p of ds.players) {
    if (!overlay.has(p.id)) continue;
    const adj = overlay.adjust(p, ds, ctx, gw);
    if (!adj) continue;
    const base = projectPlayer(p, ctx, gw);
    const patched: Player = { ...p, chanceNext: adj.engineAvailability * 100, status: ["u", "s", "n"].includes(p.status) ? "a" : p.status };
    const adjusted = projectPlayer(patched, { ...ctx, nextId: gw }, gw);
    impacts.set(p.id, impactOf(p, gw, base, adjusted, adj, overlay));
    patch.set(p.id, patched);
  }
  if (!patch.size) return { ds, impacts };
  return {
    ds: { ...ds, players: ds.players.map((p) => patch.get(p.id) ?? p), events: ds.events.map((e) => ({ ...e, isNext: e.id === gw })) },
    impacts,
  };
}

/** Attach the impact (and a short explanation) to projections produced from a news-patched dataset. */
export function annotateProjections(byId: Map<number, Projection>, impacts: Map<number, NewsImpact>) {
  for (const [id, impact] of impacts) {
    const pr = byId.get(id);
    if (!pr) continue;
    pr.news = impact;
    pr.warnings = [...pr.warnings, ...impact.adjustmentReasons.slice(0, 2).map((r) => `News: ${r}`)];
  }
}
