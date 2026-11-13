import type { Dataset } from "../fpl/types";
import { isActive } from "./events";
import { buildOverlay, applyNewsToDataset } from "./overlay";
import { freshness } from "./service";
import { SOURCES } from "./sources";
import type { NewsEvent, NewsImpact, NewsItem, NewsState } from "./types";

export interface FeedEvent {
  id: string;
  playerId: number;
  playerName: string;
  club: string;
  clubShort: string;
  pos: string;
  category: NewsItem["category"];
  impactKind: NewsItem["impact"];
  severity: NewsItem["severity"];
  status: NewsItem["status"];
  headline: string;
  summary: string;
  belief: number;
  independentSources: number;
  contradicted: boolean;
  expectedReturnDate: string | null;
  publishedAt: string;
  sources: { name: string; url: string; publishedAt: string; status: string; headline: string }[];
  /** effect on the selected gameweek's projection; null when the news does not change the model (e.g. FPL already reflects it) */
  impact: NewsImpact | null;
  upcoming: { gw: number; opp: string; home: boolean }[];
  /** FPL's own news line, shown for context */
  fplNews: string;
}

/** The dashboard payload: freshness, events (deduplicated, with all source links) and items awaiting review. */
export function buildFeed(ds: Dataset, state: NewsState, gw: number, now = new Date(), opts: { ids?: Set<number> } = {}) {
  const overlay = buildOverlay(state, now);
  const { impacts } = applyNewsToDataset(ds, gw, overlay);
  const by = new Map(ds.players.map((p) => [p.id, p]));
  const events: FeedEvent[] = [];
  for (const e of overlay?.events ?? []) {
    if (opts.ids && !opts.ids.has(e.playerId)) continue;
    const p = by.get(e.playerId);
    if (!p || e.current.impact === "none" && e.current.category === "other") continue;
    events.push(toFeedEvent(e, p, ds, impacts.get(e.playerId) ?? null, gw));
  }
  events.sort((a, b) => (b.impact ? 1 : 0) - (a.impact ? 1 : 0) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const review = state.items.filter((i) => i.needsReview && isActive(i, now)).slice(0, 30);
  return {
    gw,
    freshness: freshness(state, ds, now),
    sources: SOURCES.map((s) => ({ ...s, status: state.sourceStatus[s.id] ?? null })),
    counts: { events: events.length, changingProjections: events.filter((e) => e.impact).length, review: review.length },
    events,
    review,
  };
}

function toFeedEvent(e: NewsEvent, pl: Dataset["players"][number], ds: Dataset, impact: NewsImpact | null, gw: number): FeedEvent {
  const team = ds.teams[pl.teamId];
  const c = e.current;
  const upcoming = ds.fixtures
    .filter((f) => f.event !== null && f.event >= gw && f.event < gw + 4 && (f.teamH === pl.teamId || f.teamA === pl.teamId))
    .sort((a, b) => (a.event ?? 0) - (b.event ?? 0))
    .map((f) => ({ gw: f.event!, opp: ds.teams[f.teamH === pl.teamId ? f.teamA : f.teamH]?.short ?? "?", home: f.teamH === pl.teamId }));
  return {
    id: e.id, playerId: pl.id, playerName: pl.webName, club: team?.name ?? "", clubShort: team?.short ?? "", pos: pl.pos,
    category: c.category, impactKind: c.impact, severity: c.severity, status: c.status, headline: c.headline, summary: c.summary,
    belief: e.belief, independentSources: e.independentSources.length, contradicted: e.contradicted,
    expectedReturnDate: c.expectedReturnDate, publishedAt: c.publishedAt,
    sources: e.items.map((i) => ({ name: i.sourceName, url: i.sourceUrl, publishedAt: i.publishedAt, status: i.status, headline: i.headline })),
    impact, upcoming, fplNews: pl.news,
  };
}
