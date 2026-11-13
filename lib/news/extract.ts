import { createHash } from "node:crypto";
import type { Dataset } from "../fpl/types";
import { articleKey } from "./events";
import { clubIn, matchPlayer, norm, type PlayerIndex } from "./identity";
import { parseDayMonth, sourceMeta } from "./sources";
import { NEWS_CATEGORIES, type Impact, type NewsCategory, type NewsItem, type NewsStatus, type RawArticle, type Severity } from "./types";

export interface Extractor {
  name: string;
  extract(article: RawArticle, ds: Dataset, idx: PlayerIndex): Promise<NewsItem[]>;
}

const text = (a: RawArticle) => `${a.title}. ${a.summary}${a.text ? " " + a.text : ""}`.replace(/\s+/g, " ").trim();
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/* ------------------------------------------------------------ rules */

interface Rule { re: RegExp; category: NewsCategory; impact: Impact; severity: Severity }
const RULES: Rule[] = [
  { re: /\b(?:ruled out|will miss|set to miss|sidelined|will be out|miss the (?:next|rest)|out for (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|the)\b)/i, category: "injury", impact: "out", severity: "moderate" },
  { re: /\b(?:surgery|operation|fractured?|cruciate|ruptured?|torn|broken (?:leg|foot|ankle|toe|collarbone|rib))\b/i, category: "injury", impact: "out", severity: "major" },
  { re: /\b(?:a doubt|in doubt|doubtful|fitness test|late fitness|race against time|touch and go|unlikely to (?:play|feature))\b/i, category: "injury", impact: "doubt", severity: "minor" },
  { re: /\b(?:suspended|suspension|serves? (?:a |his )?(?:one-match |three-match )?ban|will serve a ban)\b/i, category: "suspension", impact: "out", severity: "minor" },
  { re: /\b(?:illness|virus|sickness|unwell|flu)\b/i, category: "illness", impact: "doubt", severity: "minor" },
  { re: /\b(?:international duty|called up|call-up|withdrawn from the \w+ squad|pulled out of the \w+ squad)\b/i, category: "international_duty", impact: "none", severity: "info" },
  { re: /\b(?:returns? late|late return|returned late|jet.?lag|travel(?:ling)? fatigue)\b/i, category: "late_return", impact: "reduced", severity: "minor" },
  { re: /\b(?:rested|will be rested|rotate[ds]?|rotation|left out of the (?:squad|team)|manage (?:his )?minutes)\b/i, category: "rotation", impact: "reduced", severity: "minor" },
  { re: /\b(?:back in training|returns? to training|trained (?:fully|normally)|available for selection|fit again|passed fit|cleared to play)\b/i, category: "training_update", impact: "fit", severity: "info" },
  { re: /\b(?:missed training|did not train|trained separately|limped off|injury (?:worry|scare|concern)|knock)\b/i, category: "training_update", impact: "doubt", severity: "minor" },
];

/** Reports are "confirmed" only from official sources; a publisher repeating a claim is "reported"; hedged language is "speculative". */
export function statusFor(t: string, sourceKind: string | undefined): NewsStatus {
  if (/\b(could|may|might|fears?|worr(?:y|ies)|set to|reportedly|rumou?r|expected to|likely|hopes?|poised)\b/i.test(t)) return "speculative";
  if (sourceKind === "official" || sourceKind === "club" || sourceKind === "press-conference") return "confirmed";
  return "reported";
}

function returnDateFrom(t: string, published: Date): string | null {
  const direct = parseDayMonth(t, published);
  if (direct && /until|back|return|miss|out|available|fit/i.test(t)) return direct;
  const w = t.match(/\b(?:out|sidelined|absent|miss(?:ing)?)(?: for)?\s+(?:around |about |up to |at least )?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(weeks?|months?|days?)\b/i);
  if (w) {
    const n = NUM[w[1].toLowerCase()] ?? Number(w[1]);
    const days = /week/i.test(w[2]) ? n * 7 : /month/i.test(w[2]) ? n * 30 : n;
    return new Date(published.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** Candidate names: runs of capitalised words (1-3 tokens) in the original text. */
function nameCandidates(t: string): string[] {
  const out = new Set<string>();
  const words = t.replace(/[“”"()]/g, " ").split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (let n = 3; n >= 1; n--) {
      const seg = words.slice(i, i + n);
      if (seg.length < n) continue;
      if (seg.every((w) => /^[A-ZÀ-ÖØ-Þ][\p{L}'’-]+[,.:;]?$/u.test(w))) out.add(seg.map((w) => w.replace(/[,.:;]$/, "").replace(/’s$|'s$/, "")).join(" "));
    }
  }
  return [...out];
}

/** Deterministic baseline extractor: keyword rules + identity matching. Conservative by design. */
export const heuristicExtractor: Extractor = {
  name: "heuristic",
  async extract(a, ds, idx) {
    const t = text(a);
    const kind = sourceMeta(a.sourceId)?.kind;
    const pub = new Date(a.publishedAt);
    const club = clubIn(t, idx);
    const items: NewsItem[] = [];
    const seen = new Set<number | string>();
    for (const sent of sentences(t)) {
      const rule = RULES.find((r) => r.re.test(sent));
      if (!rule) continue;
      const at = sent.search(rule.re);
      // Bind the keyword to ONE player: the nearest capitalised name (preferring one just before the keyword), so a
      // sentence naming the scorer and the injured player does not tag both.
      const cands = nameCandidates(sent)
        .map((c) => ({ c, pos: sent.indexOf(c) }))
        .filter((x) => x.pos >= 0)
        .map((x) => ({ ...x, d: x.pos < at ? at - (x.pos + x.c.length) : (x.pos - at) * 1.5 }))
        .sort((a, b) => a.d - b.d);
      let chosen: { c: string; m: ReturnType<typeof matchPlayer> } | null = null;
      for (const x of cands) {
        const m = matchPlayer(x.c, idx, club);
        if (m.playerId !== null || m.ambiguous) { chosen = { c: x.c, m }; break; }
      }
      if (!chosen) continue;
      const { c: cand, m } = chosen;
      {
        const key = m.playerId ?? `amb:${norm(cand)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = m.playerId !== null ? idx.players.get(m.playerId)! : null;
        const status = statusFor(sent, kind);
        const ret = rule.impact === "out" || rule.impact === "doubt" ? returnDateFrom(sent, pub) : null;
        items.push({
          id: createHash("sha1").update(`${a.url}|${key}|${rule.category}`).digest("hex").slice(0, 16),
          playerId: p?.id ?? null, playerName: p ? `${p.firstName} ${p.secondName}`.trim() : cand,
          club: p ? ds.teams[p.teamId]?.name ?? "" : club ? ds.teams[club]?.name ?? "" : "",
          category: rule.category, severity: rule.severity, impact: rule.impact,
          headline: a.title, summary: a.summary || a.title,
          sourceId: a.sourceId, sourceName: sourceMeta(a.sourceId)?.name ?? a.sourceId, sourceUrl: a.url,
          publishedAt: a.publishedAt, retrievedAt: a.retrievedAt, expectedReturnDate: ret, status,
          confidence: Math.round(Math.min(0.75, m.confidence * (status === "speculative" ? 0.7 : 0.85)) * 100) / 100,
          affectedGameweeks: [], evidence: sent, needsReview: m.ambiguous || undefined,
          reviewReason: m.ambiguous ? m.reason : undefined, candidates: m.ambiguous ? m.candidates : undefined,
          articleKey: articleKey(a.url, a.title),
        });
      }
    }
    return items;
  },
};

/* ------------------------------------------------------------ LLM */

export type LlmCall = (system: string, user: string) => Promise<string>;

const SYSTEM = `You extract football availability news from one article for a Fantasy Premier League tool.
Rules:
- Output ONLY a JSON array (no prose). Each element describes one player that the article says something about regarding fitness, availability, suspension, international duty, late returns, rotation, training or team news.
- Use only information stated in the article. NEVER invent a player, a date, a return timeline, a club or a source.
- "evidence" must be a VERBATIM excerpt (max 240 chars) copied from the article.
- "expectedReturnDate" must be an ISO date (YYYY-MM-DD) ONLY if the article states a date or a duration you can convert; otherwise null.
- "status": "confirmed" (stated as fact by the club/manager/official source), "reported" (a publisher reporting it), "speculative" (hedged: could/may/fears).
- "impact": "out" | "doubt" | "reduced" (plays fewer minutes/rotation) | "fit" (cleared/available) | "none".
- "category": one of ${NEWS_CATEGORIES.join(", ")}. "severity": minor | moderate | major | info.
- Skip players only mentioned in passing. If nothing relevant, output [].
Element schema: {"playerName": string, "club": string|null, "category": string, "severity": string, "impact": string, "status": string, "headline": string, "summary": string (max 200 chars), "expectedReturnDate": string|null, "affectedGameweeks": number[], "evidence": string, "confidence": number 0..1}`;

const IMPACTS: Impact[] = ["out", "doubt", "reduced", "fit", "none"];
const SEVS: Severity[] = ["minor", "moderate", "major", "info"];
const STATS: NewsStatus[] = ["confirmed", "reported", "speculative"];

export function dateSupported(date: string, source: string): boolean {
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const mon = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][d.getUTCMonth()];
  const s = source.toLowerCase();
  const day = d.getUTCDate();
  const namedDate = (s.includes(mon) || s.includes(mon.slice(0, 3))) && new RegExp(`\\b${day}(?:st|nd|rd|th)?\\b`).test(s);
  const duration = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(weeks?|months?|days?)\b/.test(s);
  return namedDate || duration;
}

/** Validate an LLM answer against the article and the real player dataset. The model never supplies ids, urls or timestamps. */
export function validateLlmItems(raw: string, a: RawArticle, ds: Dataset, idx: PlayerIndex): NewsItem[] {
  let arr: unknown;
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    arr = JSON.parse(m ? m[0] : raw);
  } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const source = text(a);
  const normSource = norm(source);
  const kind = sourceMeta(a.sourceId)?.kind;
  const out: NewsItem[] = [];
  for (const e of arr.slice(0, 12) as Record<string, unknown>[]) {
    if (!e || typeof e.playerName !== "string" || typeof e.evidence !== "string") continue;
    const category = NEWS_CATEGORIES.includes(e.category as NewsCategory) ? (e.category as NewsCategory) : null;
    const impact = IMPACTS.includes(e.impact as Impact) ? (e.impact as Impact) : null;
    if (!category || !impact) continue;
    if (!normSource.includes(norm(e.evidence).slice(0, 200)) || norm(e.evidence).length < 8) continue; // evidence must be real
    if (!normSource.includes(norm(e.playerName).split(" ").pop() ?? "§")) continue; // the player must actually be named
    const clubId = typeof e.club === "string" ? clubIn(e.club, idx) : clubIn(source, idx);
    const m = matchPlayer(e.playerName, idx, clubId);
    const p = m.playerId !== null ? idx.players.get(m.playerId)! : null;
    let status = STATS.includes(e.status as NewsStatus) ? (e.status as NewsStatus) : "reported";
    // A publisher cannot "confirm" on the club's behalf: cap at reported unless the source itself is official.
    if (status === "confirmed" && kind !== "official" && kind !== "club" && kind !== "press-conference") status = "reported";
    let ret = typeof e.expectedReturnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.expectedReturnDate) ? e.expectedReturnDate : null;
    let conf = typeof e.confidence === "number" ? Math.min(0.9, Math.max(0.1, e.confidence)) : 0.5;
    if (ret && !dateSupported(ret, source)) { ret = null; conf = Math.min(conf, 0.5); }
    const gws = Array.isArray(e.affectedGameweeks) ? e.affectedGameweeks.filter((g): g is number => Number.isInteger(g) && g >= 1 && g <= 38).slice(0, 10) : [];
    out.push({
      id: createHash("sha1").update(`${a.url}|${m.playerId ?? e.playerName}|${category}`).digest("hex").slice(0, 16),
      playerId: p?.id ?? null, playerName: p ? `${p.firstName} ${p.secondName}`.trim() : String(e.playerName).slice(0, 60),
      club: p ? ds.teams[p.teamId]?.name ?? "" : clubId ? ds.teams[clubId]?.name ?? "" : "",
      category, severity: SEVS.includes(e.severity as Severity) ? (e.severity as Severity) : "info", impact,
      headline: typeof e.headline === "string" ? e.headline.slice(0, 160) : a.title, summary: typeof e.summary === "string" ? e.summary.slice(0, 240) : a.summary.slice(0, 240),
      sourceId: a.sourceId, sourceName: sourceMeta(a.sourceId)?.name ?? a.sourceId, sourceUrl: a.url,
      publishedAt: a.publishedAt, retrievedAt: a.retrievedAt, expectedReturnDate: ret, status, confidence: conf,
      affectedGameweeks: gws, evidence: String(e.evidence).slice(0, 240),
      needsReview: m.playerId === null ? true : undefined,
      reviewReason: m.playerId === null ? (m.ambiguous ? m.reason : "player not found in the FPL dataset") : undefined,
      candidates: m.ambiguous ? m.candidates : undefined, articleKey: articleKey(a.url, a.title),
    });
  }
  return out;
}

export function llmExtractor(call: LlmCall): Extractor {
  return {
    name: "llm",
    async extract(a, ds, idx) {
      const user = `Article (source: ${a.sourceId}, published ${a.publishedAt}):\nTitle: ${a.title}\nSummary: ${a.summary}${a.text ? "\nText: " + a.text.slice(0, 6000) : ""}`;
      return validateLlmItems(await call(SYSTEM, user), a, ds, idx);
    },
  };
}

/** Anthropic Messages API call using SERVER-side credentials only. */
export function anthropicCall(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): LlmCall | null {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const base = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const model = env.NEWS_LLM_MODEL ?? "claude-haiku-5-5";
  return async (system, user) => {
    const res = await fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, temperature: 0, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`LLM extraction failed (${res.status})`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  };
}

/** Google Gemini generateContent call using SERVER-side credentials only (GEMINI_API_KEY). */
export function geminiCall(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): LlmCall | null {
  const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (!key) return null;
  const model = env.NEWS_LLM_MODEL ?? "gemini-3.1-flash-lite";
  const base = (env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  return async (system, user) => {
    const res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1500, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`LLM extraction failed (${res.status})`);
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  };
}

/** DeepSeek (OpenAI-compatible chat completions) using SERVER-side credentials only (DEEPSEEK_API_KEY). */
export function deepseekCall(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): LlmCall | null {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const model = env.NEWS_LLM_MODEL ?? "deepseek-chat";
  const base = (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  return async (system, user) => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: "system", content: system }, { role: "user", content: user + "\n\nReturn only the JSON array." }] }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`LLM extraction failed (${res.status})`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  };
}

/** Provider order: NEWS_LLM_PROVIDER (gemini | deepseek | anthropic) if set, else the first key found. */
export function pickLlm(env: Record<string, string | undefined> = process.env): { name: string; call: LlmCall } | null {
  const all: [string, LlmCall | null][] = [["gemini", geminiCall(env)], ["deepseek", deepseekCall(env)], ["anthropic", anthropicCall(env)]];
  const want = env.NEWS_LLM_PROVIDER;
  const chosen = (want && all.find(([n, c]) => n === want && c)) || all.find(([, c]) => c);
  return chosen ? { name: chosen[0], call: chosen[1]! } : null;
}

/** LLM when configured (Gemini, DeepSeek or Anthropic via pickLlm), otherwise (or if it fails) the deterministic baseline. */
export const llmHealth: { lastError: string | null; lastOkAt: string | null; provider: string | null } = { lastError: null, lastOkAt: null, provider: null };

export function defaultExtractor(env: Record<string, string | undefined> = process.env): Extractor {
  const picked = pickLlm(env);
  if (!picked) return heuristicExtractor;
  const llm = llmExtractor(picked.call);
  return {
    name: `${picked.name}+heuristic-fallback`,
    async extract(a, ds, idx) {
      try {
        const r = await llm.extract(a, ds, idx);
        llmHealth.lastError = null; llmHealth.lastOkAt = new Date().toISOString(); llmHealth.provider = picked.name;
        return r;
      } catch (e) {
        llmHealth.lastError = (e as Error).message; llmHealth.provider = picked.name; // surfaced in the dashboard; never silent
        return heuristicExtractor.extract(a, ds, idx);
      }
    },
  };
}
