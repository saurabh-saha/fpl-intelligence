import type { Dataset } from "../fpl/types";
import { dedupeArticles, isDuplicateArticle } from "./events";
import { defaultExtractor, llmHealth, pickLlm, type Extractor } from "./extract";
import { buildPlayerIndex, clubIn, matchPlayer } from "./identity";
import { buildOverlay, type NewsOverlay } from "./overlay";
import { FileNewsRepository, type NewsRepository } from "./repository";
import { defaultAdapters, type SourceAdapter } from "./sources";
import { emptyNewsState, type NewsItem, type NewsState, type RawArticle } from "./types";

const MIN = 60_000;
export const MIN_ATTEMPT_GAP_MS = 30_000; // rate limit between refresh attempts, including manual ones
export const MAX_EXTRACT_PER_REFRESH = 12;
const MAX_ITEMS = 800;
const PRUNE_DAYS = 60;

/** Refresh cadence tightens as the FPL deadline approaches. */
export function refreshTtlMs(ds: Dataset, now: Date): number {
  const next = ds.events.find((e) => e.isNext) ?? ds.events.find((e) => !e.finished);
  const hours = next?.deadline ? (Date.parse(next.deadline) - now.getTime()) / 3_600_000 : Infinity;
  if (hours <= 0) return 30 * MIN;
  if (hours <= 6) return 5 * MIN;
  if (hours <= 24) return 10 * MIN;
  if (hours <= 72) return 20 * MIN;
  return 45 * MIN;
}

export interface Freshness {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  ttlMinutes: number;
  /** "live" only when the last SUCCESSFUL refresh is within one refresh window; otherwise never claimed as live */
  label: "live" | "stale" | "never";
  minutesSinceSuccess: number | null;
  hoursToDeadline: number | null;
  sources: NewsState["sourceStatus"];
}

export function freshness(state: NewsState, ds: Dataset, now = new Date()): Freshness {
  const ttl = refreshTtlMs(ds, now);
  const ok = state.lastSuccessAt ? now.getTime() - Date.parse(state.lastSuccessAt) : null;
  const next = ds.events.find((e) => e.isNext);
  return {
    lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt, ttlMinutes: Math.round(ttl / MIN),
    label: ok === null ? "never" : ok <= ttl * 1.5 ? "live" : "stale",
    minutesSinceSuccess: ok === null ? null : Math.round(ok / MIN),
    hoursToDeadline: next?.deadline ? Math.round(((Date.parse(next.deadline) - now.getTime()) / 3_600_000) * 10) / 10 : null,
    sources: state.sourceStatus,
  };
}

const AVAIL_WORDS = /injur|doubt|fitness|ruled out|miss|sidelined|suspend|red card|ban\b|international|call-up|called up|rest|rotat|training|illness|surgery|return|back from|knock|available|withdrawn|concern/i;

export interface RefreshOptions {
  ds: Dataset;
  repo: NewsRepository;
  adapters?: SourceAdapter[];
  extractor?: Extractor;
  now?: Date;
  force?: boolean; // manual refresh: bypasses the freshness window, NOT the attempt rate limit
}
export interface RefreshResult { refreshed: boolean; reason?: string; state: NewsState; added: number; failed: string[] }

let inflight: Promise<RefreshResult> | null = null;

export async function refreshNews(opts: RefreshOptions): Promise<RefreshResult> {
  if (inflight) return inflight; // request de-duplication
  inflight = doRefresh(opts).finally(() => { inflight = null; });
  return inflight;
}

async function doRefresh(o: RefreshOptions): Promise<RefreshResult> {
  const now = o.now ?? new Date();
  const state = await o.repo.load();
  if (state.lastAttemptAt && now.getTime() - Date.parse(state.lastAttemptAt) < MIN_ATTEMPT_GAP_MS) return { refreshed: false, reason: "rate-limited", state, added: 0, failed: [] };
  if (!o.force && state.lastSuccessAt && now.getTime() - Date.parse(state.lastSuccessAt) < refreshTtlMs(o.ds, now)) return { refreshed: false, reason: "fresh", state, added: 0, failed: [] };

  const adapters = o.adapters ?? defaultAdapters();
  const extractor = o.extractor ?? defaultExtractor();
  const idx = buildPlayerIndex(o.ds);
  const next: NewsState = { ...state, items: [...state.items], sourceStatus: { ...state.sourceStatus }, seenArticles: { ...state.seenArticles }, lastAttemptAt: now.toISOString() };
  const failed: string[] = [];
  let anyOk = false;
  let added = 0;
  const articles: RawArticle[] = [];

  for (const a of adapters) {
    try {
      const r = await a.fetch({ ds: o.ds, now });
      anyOk = true;
      if (r.items) {
        // structured sources replace their own previous items wholesale (the source is authoritative for its current state)
        next.items = next.items.filter((i) => i.sourceId !== a.meta.id).concat(r.items);
        added += r.items.length;
      }
      if (r.articles) articles.push(...r.articles);
      next.sourceStatus[a.meta.id] = { ok: true, at: now.toISOString(), count: (r.items?.length ?? 0) + (r.articles?.length ?? 0) };
    } catch (e) {
      failed.push(a.meta.id);
      next.sourceStatus[a.meta.id] = { ok: false, at: now.toISOString(), error: (e as Error).message.slice(0, 160) };
    }
  }

  // Articles: de-duplicate, skip ones already processed, pre-filter for availability relevance, cap the extraction budget.
  const fresh = dedupeArticles(articles).filter((a) => !Object.prototype.hasOwnProperty.call(next.seenArticles, a.url));
  let budget = MAX_EXTRACT_PER_REFRESH;
  for (const a of fresh.sort((x, y) => Date.parse(y.publishedAt) - Date.parse(x.publishedAt))) {
    if (isRelevant(a, idx) === false) { next.seenArticles[a.url] = now.toISOString(); continue; }
    if (budget-- <= 0) break;
    try {
      const items = await extractor.extract(a, o.ds, idx);
      next.seenArticles[a.url] = now.toISOString();
      for (const it of items) if (!next.items.some((x) => x.id === it.id)) { next.items.push(it); added++; }
    } catch { /* leave unseen so it is retried next refresh */ }
  }

  const llm = pickLlm();
  next.sourceStatus.extractor = llm
    ? { ok: !llmHealth.lastError, at: now.toISOString(), error: llmHealth.lastError ? `${llm.name} extraction failed (${llmHealth.lastError}); using the rule-based fallback` : undefined, count: undefined }
    : { ok: true, at: now.toISOString(), error: "no LLM key configured: rule-based extraction only" };
  next.items = prune(next.items, now);
  if (anyOk) next.lastSuccessAt = now.toISOString();
  const seen = Object.entries(next.seenArticles).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 600);
  next.seenArticles = Object.fromEntries(seen);
  await o.repo.save(next);
  return { refreshed: anyOk, reason: anyOk ? undefined : "all-sources-failed", state: next, added, failed };
}

function isRelevant(a: RawArticle, idx: ReturnType<typeof buildPlayerIndex>): boolean {
  const t = `${a.title}. ${a.summary}`;
  if (!AVAIL_WORDS.test(t)) return false;
  const club = clubIn(t, idx);
  for (const m of t.matchAll(/\b[A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){0,2}/gu)) {
    const r = matchPlayer(m[0], idx, club);
    if (r.playerId !== null) return true;
  }
  return false;
}

export function prune(items: NewsItem[], now: Date): NewsItem[] {
  const cutoff = now.getTime() - PRUNE_DAYS * 86_400_000;
  const kept = items.filter((i) => Date.parse(i.publishedAt) >= cutoff);
  return kept.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, MAX_ITEMS);
}

/* ------------------------------------------------------------ process-wide access (server only) */

const g = globalThis as unknown as { __newsRepo?: NewsRepository; __newsCache?: { at: number; state: NewsState } };
export const getRepository = (): NewsRepository => (g.__newsRepo ??= new FileNewsRepository());
export function setRepository(r: NewsRepository | undefined) { g.__newsRepo = r; g.__newsCache = undefined; }

export async function loadState(maxAgeMs = 20_000): Promise<NewsState> {
  const c = g.__newsCache;
  if (c && Date.now() - c.at < maxAgeMs) return c.state;
  const state = await getRepository().load();
  g.__newsCache = { at: Date.now(), state };
  return state;
}
export const invalidateCache = () => { g.__newsCache = undefined; };

/** The overlay used by strategy routes. Read-only: never triggers network I/O, so it cannot slow or break a request. */
export async function loadOverlay(opts: { disabled?: boolean } = {}): Promise<NewsOverlay | null> {
  if (opts.disabled || process.env.NEWS_DISABLED === "1") return null;
  try { return buildOverlay(await loadState(), new Date()); } catch { return null; }
}

export { emptyNewsState, isDuplicateArticle };
