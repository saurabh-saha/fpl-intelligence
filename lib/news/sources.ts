import { createHash } from "node:crypto";
import type { Dataset, Player } from "../fpl/types";
import { articleKey } from "./events";
import type { Impact, NewsCategory, NewsItem, RawArticle, Severity, SourceMeta } from "./types";

/**
 * Source adapters. Each adapter returns either raw articles (to be run through an extractor) or already-structured
 * items. Only sources that can be read reliably and within their terms are implemented:
 *
 *  - fpl-official: the official FPL status/news fields (bootstrap-static). Structured, free, public API.
 *  - bbc-sport-pl: BBC Sport Premier League RSS. We read only the public feed's headline/summary/link (no article
 *    scraping) and always link back to the original. BBC feeds are offered for personal, non-commercial use:
 *    review the BBC terms before any commercial deployment.
 *  - extra RSS feeds can be configured with the NEWS_RSS_FEEDS environment variable (see docs/NEWS_INTELLIGENCE.md).
 *
 * Not implemented (no reliable, permitted access): premierleague.com and club sites (no public feed/API, scraping
 * restricted), press-conference transcripts, social media, and international squad announcements.
 */
export const SOURCES: SourceMeta[] = [
  { id: "fpl-official", name: "Official FPL status", kind: "official", reliability: 0.95, note: "FPL's own injury/suspension flags and news text." },
  { id: "bbc-sport-pl", name: "BBC Sport", kind: "publisher", reliability: 0.7, note: "Public Premier League RSS feed (headline and summary only)." },
];

export const extraFeeds = (env: Record<string, string | undefined> = process.env): { id: string; name: string; url: string; reliability: number }[] => {
  try {
    const raw = env.NEWS_RSS_FEEDS;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((f) => f?.id && f?.url && /^https:\/\//.test(f.url)).map((f) => ({ id: String(f.id), name: String(f.name ?? f.id), url: String(f.url), reliability: Math.min(0.9, Math.max(0.1, Number(f.reliability ?? 0.5))) })) : [];
  } catch { return []; }
};

export const SOURCE_RELIABILITY: Record<string, number> = Object.fromEntries(SOURCES.map((s) => [s.id, s.reliability]));
export const sourceMeta = (id: string): SourceMeta | undefined => SOURCES.find((s) => s.id === id);

export interface SourceAdapter {
  meta: SourceMeta;
  fetch(ctx: { ds: Dataset; now: Date }): Promise<{ articles?: RawArticle[]; items?: NewsItem[] }>;
}

/* ------------------------------------------------------------ FPL official */

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const monthIdx = (s: string) => MONTHS[s.slice(0, 3).toLowerCase()];

/** "29 Nov" / "20 December" -> YYYY-MM-DD, choosing the year so the date is not implausibly in the past. */
export function parseDayMonth(text: string, ref: Date): string | null {
  const m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  if (!m) return null;
  const mo = monthIdx(m[2]);
  let y = ref.getUTCFullYear();
  let d = new Date(Date.UTC(y, mo, Number(m[1])));
  if (d.getTime() < ref.getTime() - 45 * 86_400_000) d = new Date(Date.UTC(y + 1, mo, Number(m[1])));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== mo) return null;
  return d.toISOString().slice(0, 10);
}

const INJURY_WORDS = /injur|knock|strain|fractur|surgery|operation|hamstring|ankle|knee|thigh|calf|groin|muscle|back problem|foot|shoulder|concussion|ligament|cruciate|acl|tendon|hip|illness|ill\b|virus|flu\b|sickness/i;
const MAJOR_WORDS = /surgery|operation|fractur|cruciate|acl|rupture|torn|broken|season/i;

export function parseFplNews(p: Player, retrievedAt: string): NewsItem | null {
  const text = p.news.trim();
  if (!text) return null;
  const published = p.newsAdded ?? retrievedAt;
  const ref = new Date(published);
  const chance = text.match(/(\d{1,3})%\s+chance/i);
  const ret = parseDayMonth(text, ref);
  const club = "";
  let category: NewsCategory = "other";
  let impact: Impact = "none";
  let severity: Severity = "info";
  if (/suspend|suspension|banned|\bban\b/i.test(text)) { category = "suspension"; impact = "out"; severity = "minor"; }
  else if (/international/i.test(text)) { category = "international_duty"; impact = "reduced"; severity = "info"; }
  else if (/illness|\bill\b|virus|flu\b|sickness/i.test(text)) { category = "illness"; impact = "out"; severity = "minor"; }
  else if (INJURY_WORDS.test(text) || p.status === "i" || p.status === "d") { category = "injury"; impact = "out"; severity = MAJOR_WORDS.test(text) ? "major" : /unknown return/i.test(text) ? "moderate" : "minor"; }
  if (impact === "out" && chance && Number(chance[1]) >= 25 && Number(chance[1]) <= 75) impact = "doubt";
  if (impact === "out" && chance && Number(chance[1]) >= 100) impact = "none";
  if (category === "injury" && ret && Date.parse(ret) - ref.getTime() > 42 * 86_400_000) severity = "major";
  if (/joined|left the club|transfer|loan|released|retired/i.test(text)) { category = "other"; impact = "none"; severity = "info"; }
  const id = createHash("sha1").update(`fpl:${p.id}:${text}:${published}`).digest("hex").slice(0, 16);
  return {
    id, playerId: p.id, playerName: `${p.firstName} ${p.secondName}`.trim(), club, category, severity, impact,
    headline: `${p.webName}: ${text}`, summary: text,
    sourceId: "fpl-official", sourceName: "Official FPL status", sourceUrl: "https://fantasy.premierleague.com/statistics",
    publishedAt: published, retrievedAt, expectedReturnDate: category === "suspension" || category === "injury" || category === "illness" ? ret : null,
    status: "confirmed", confidence: 0.95, affectedGameweeks: [], evidence: text, representedInFpl: true,
    articleKey: articleKey("https://fantasy.premierleague.com/statistics#" + p.id, text),
  };
}

export const fplOfficialAdapter: SourceAdapter = {
  meta: SOURCES[0],
  async fetch({ ds, now }) {
    const at = now.toISOString();
    const items: NewsItem[] = [];
    for (const p of ds.players) {
      const it = parseFplNews(p, at);
      if (!it) continue;
      it.club = ds.teams[p.teamId]?.name ?? "";
      items.push(it);
    }
    return { items };
  },
};

/* ------------------------------------------------------------ RSS */

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const tag = (block: string, t: string) => { const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? decode(m[1]) : ""; };

export function parseRss(xml: string, sourceId: string, retrievedAt: string): RawArticle[] {
  const out: RawArticle[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const url = tag(b, "link") || tag(b, "guid");
    const title = tag(b, "title");
    const pub = Date.parse(tag(b, "pubDate"));
    if (!/^https?:\/\//.test(url) || !title || Number.isNaN(pub)) continue;
    out.push({ sourceId, url, title, summary: tag(b, "description"), publishedAt: new Date(pub).toISOString(), retrievedAt });
  }
  return out;
}

export function rssAdapter(meta: SourceMeta, url: string, fetchImpl: typeof fetch = fetch): SourceAdapter {
  return {
    meta,
    async fetch({ now }) {
      const res = await fetchImpl(url, { headers: { "user-agent": "fpl-intelligence/1.0 (news reader; respects feed terms)", accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!res.ok) throw new Error(`${meta.name} feed returned ${res.status}`);
      return { articles: parseRss(await res.text(), meta.id, now.toISOString()) };
    },
  };
}

export function defaultAdapters(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): SourceAdapter[] {
  const list: SourceAdapter[] = [fplOfficialAdapter, rssAdapter(SOURCES[1], "https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml", fetchImpl)];
  for (const f of extraFeeds(env)) {
    SOURCE_RELIABILITY[f.id] = f.reliability;
    list.push(rssAdapter({ id: f.id, name: f.name, kind: "publisher", reliability: f.reliability, note: "Configured RSS feed" }, f.url, fetchImpl));
  }
  return list;
}
