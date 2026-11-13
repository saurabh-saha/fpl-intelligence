/** News Intelligence data model. Everything is JSON-serialisable. */
export type NewsCategory =
  | "injury" | "illness" | "suspension" | "international_duty" | "international_fatigue" | "late_return"
  | "rotation" | "training_update" | "manager_update" | "confirmed_team_news" | "other";
export type NewsStatus = "confirmed" | "reported" | "speculative";
export type Severity = "minor" | "moderate" | "major" | "info";
/** What the item says about the player's availability for the affected gameweeks. */
export type Impact = "out" | "doubt" | "reduced" | "fit" | "none";

export const NEWS_CATEGORIES: NewsCategory[] = ["injury", "illness", "suspension", "international_duty", "international_fatigue", "late_return", "rotation", "training_update", "manager_update", "confirmed_team_news", "other"];

export interface NewsItem {
  id: string;
  playerId: number | null;
  playerName: string;
  club: string;
  category: NewsCategory;
  severity: Severity;
  impact: Impact;
  headline: string;
  summary: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  retrievedAt: string;
  expectedReturnDate: string | null; // YYYY-MM-DD
  status: NewsStatus;
  confidence: number; // 0..1, the extractor's confidence in the extraction itself
  affectedGameweeks: number[];
  evidence: string; // verbatim excerpt from the source text
  /** true when FPL's own status/chance fields already encode this (so it is never double counted for the next gameweek) */
  representedInFpl?: boolean;
  needsReview?: boolean;
  reviewReason?: string;
  candidates?: number[]; // possible player ids when identity was ambiguous
  articleKey: string;
}

/** A raw article/feed entry before extraction. */
export interface RawArticle {
  sourceId: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: string;
  retrievedAt: string;
  text?: string;
}

export interface SourceMeta {
  id: string;
  name: string;
  kind: "official" | "club" | "publisher" | "press-conference" | "schedule";
  /** 0..1 prior reliability of the source for availability news */
  reliability: number;
  note: string;
}

/** One real-world event for a player after de-duplication (many articles -> one event). */
export interface NewsEvent {
  id: string;
  playerId: number;
  group: "availability" | "minutes" | "context";
  current: NewsItem; // the item that defines the event's present state
  items: NewsItem[]; // every supporting item (newest first); all kept for inspection
  independentSources: string[];
  /** combined belief that the event is real, 0..1, from distinct sources only */
  belief: number;
  contradicted: boolean;
  active: boolean;
}

export interface NewsImpact {
  playerId: number;
  gw: number;
  baseXpts: number;
  newsAdjustedXpts: number;
  baseStartProbability: number;
  adjustedStartProbability: number;
  baseExpectedMinutes: number;
  adjustedExpectedMinutes: number;
  availabilityStatus: "available" | "doubtful" | "likely-out" | "out" | "reduced-minutes" | "returning";
  availabilityConfidence: number;
  reasonCodes: string[];
  adjustmentReasons: string[];
  supportingNewsIds: string[];
  sources: { name: string; url: string; publishedAt: string; status: NewsStatus }[];
}

export interface NewsState {
  version: 1;
  items: NewsItem[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  sourceStatus: Record<string, { ok: boolean; at: string; error?: string; count?: number }>;
  /** article keys already extracted, so an article is never sent to the extractor twice */
  seenArticles: Record<string, string>;
}

export const emptyNewsState = (): NewsState => ({ version: 1, items: [], lastAttemptAt: null, lastSuccessAt: null, sourceStatus: {}, seenArticles: {} });
