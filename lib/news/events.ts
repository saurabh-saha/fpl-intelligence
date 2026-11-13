import { createHash } from "node:crypto";
import type { NewsCategory, NewsEvent, NewsItem, NewsStatus } from "./types";

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(iso);

/* ------------------------------------------------------------ reliability */

export const STATUS_WEIGHT: Record<NewsStatus, number> = { confirmed: 1, reported: 0.6, speculative: 0.25 };

/** Prior reliability of a source id (see SourceMeta). Unknown sources get a conservative default. */
export function sourceReliability(sourceId: string, registry: Record<string, number> = {}): number {
  return registry[sourceId] ?? 0.4;
}

/* ------------------------------------------------------------ article dedupe */

const STOP = new Set(["the", "a", "an", "of", "to", "in", "for", "on", "and", "at", "is", "are", "will", "be", "with", "as", "by", "after", "his", "he"]);
const tokens = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));

export function canonicalUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = ""; x.search = "";
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return u.toLowerCase(); }
}

export const articleKey = (url: string, title: string) => createHash("sha1").update(canonicalUrl(url) + "|" + [...tokens(title)].sort().join(" ")).digest("hex").slice(0, 16);

export function titleSimilarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Same article if the canonical URL matches, or the headlines are near-identical within 48h. */
export function isDuplicateArticle(a: { url: string; title: string; publishedAt: string }, b: { url: string; title: string; publishedAt: string }): boolean {
  if (canonicalUrl(a.url) === canonicalUrl(b.url)) return true;
  return Math.abs(ms(a.publishedAt) - ms(b.publishedAt)) < 2 * DAY && titleSimilarity(a.title, b.title) >= 0.8;
}

export function dedupeArticles<T extends { url: string; title: string; publishedAt: string }>(list: T[]): T[] {
  const out: T[] = [];
  for (const a of [...list].sort((x, y) => ms(x.publishedAt) - ms(y.publishedAt))) if (!out.some((b) => isDuplicateArticle(a, b))) out.push(a);
  return out;
}

/* ------------------------------------------------------------ expiry */

/** Days an item without an explicit return date stays relevant after publication. */
export const TTL_DAYS: Record<NewsCategory, number> = {
  injury: 28, illness: 10, suspension: 21, international_duty: 14, international_fatigue: 5, late_return: 7,
  rotation: 7, training_update: 4, manager_update: 5, confirmed_team_news: 2, other: 7,
};

export function expiresAt(i: NewsItem): number {
  const base = ms(i.publishedAt) + TTL_DAYS[i.category] * DAY * (i.status === "speculative" ? 0.5 : 1);
  if (i.expectedReturnDate) return Math.max(base, ms(i.expectedReturnDate + "T23:59:59Z") + 14 * DAY);
  return base;
}
export const isActive = (i: NewsItem, now: Date) => now.getTime() < expiresAt(i) && ms(i.publishedAt) <= now.getTime() + DAY;

/* ------------------------------------------------------------ events */

const GROUP: Record<NewsCategory, NewsEvent["group"]> = {
  injury: "availability", illness: "availability", suspension: "availability", international_duty: "availability",
  late_return: "minutes", international_fatigue: "minutes", rotation: "minutes", training_update: "availability",
  manager_update: "availability", confirmed_team_news: "availability", other: "context",
};
// Injury, illness, training and manager updates about the same player describe one fitness story.
const CLUSTER_KEY: Record<NewsCategory, string> = {
  injury: "fitness", illness: "fitness", training_update: "fitness", manager_update: "fitness",
  suspension: "suspension", international_duty: "international", international_fatigue: "minutes", late_return: "minutes",
  rotation: "rotation", confirmed_team_news: "teamnews", other: "other",
};

/**
 * Collapse items into events. Several publishers reporting one injury are ONE event whose belief combines
 * only DISTINCT sources (a source's latest item counts once); newer information supersedes older.
 */
export function buildEvents(items: NewsItem[], reliability: Record<string, number>, now: Date): NewsEvent[] {
  const byKey = new Map<string, NewsItem[]>();
  for (const it of items) {
    if (it.playerId === null || it.needsReview) continue;
    const k = `${it.playerId}:${CLUSTER_KEY[it.category]}`;
    byKey.set(k, [...(byKey.get(k) ?? []), it]);
  }
  const events: NewsEvent[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => ms(b.publishedAt) - ms(a.publishedAt));
    const latestPerSource = new Map<string, NewsItem>();
    for (const it of sorted) if (!latestPerSource.has(it.sourceId)) latestPerSource.set(it.sourceId, it);
    const live = [...latestPerSource.values()].filter((i) => isActive(i, now));
    // The present state = newest item from a source that is reasonably reliable relative to the best one.
    const maxRel = Math.max(0, ...live.map((i) => sourceReliability(i.sourceId, reliability)));
    const trusted = live.filter((i) => sourceReliability(i.sourceId, reliability) >= 0.6 * maxRel);
    const current = (trusted.length ? trusted : live).sort((a, b) => ms(b.publishedAt) - ms(a.publishedAt))[0];
    if (!current) {
      events.push({ id: key, playerId: sorted[0].playerId!, group: GROUP[sorted[0].category], current: sorted[0], items: sorted, independentSources: [], belief: 0, contradicted: false, active: false });
      continue;
    }
    // Belief combines distinct sources that AGREE with the current state's direction.
    const agree = live.filter((i) => polarity(i) === polarity(current));
    const belief = 1 - agree.reduce((p, i) => p * (1 - sourceReliability(i.sourceId, reliability) * STATUS_WEIGHT[i.status] * i.confidence), 1);
    const opposed = live.filter((i) => polarity(i) !== 0 && polarity(current) !== 0 && polarity(i) !== polarity(current));
    // Contradiction: a reliable opposing report from a different source within 48h of the current item.
    const contradicted = opposed.some((o) => o.sourceId !== current.sourceId && Math.abs(ms(o.publishedAt) - ms(current.publishedAt)) < 2 * DAY && sourceReliability(o.sourceId, reliability) >= 0.5);
    events.push({ id: key, playerId: current.playerId!, group: GROUP[current.category], current, items: sorted, independentSources: [...new Set(agree.map((i) => i.sourceId))], belief: Math.round(belief * 1000) / 1000, contradicted, active: true });
  }
  return events;
}

/** -1: says the player is less available, +1: says available, 0: neutral. */
export function polarity(i: NewsItem): -1 | 0 | 1 {
  if (i.impact === "out" || i.impact === "doubt" || i.impact === "reduced") return -1;
  if (i.impact === "fit") return 1;
  return 0;
}
