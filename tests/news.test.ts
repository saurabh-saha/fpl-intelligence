import { describe, expect, it, vi } from "vitest";
import { buildModelContext, projectPlayer } from "@/lib/analytics/expectedPoints";
import { projectAll } from "@/lib/analytics/playerScoring";
import { optimizeSquad } from "@/lib/optimizer/squadOptimizer";
import { adjustAvailability } from "@/lib/news/availability";
import { buildEvents, dedupeArticles, expiresAt, isActive, isDuplicateArticle, articleKey } from "@/lib/news/events";
import { anthropicCall, deepseekCall, geminiCall, heuristicExtractor, llmExtractor, validateLlmItems } from "@/lib/news/extract";
import { buildFeed } from "@/lib/news/feed";
import { buildPlayerIndex, matchPlayer } from "@/lib/news/identity";
import { NewsOverlay, applyNewsToDataset, buildOverlay, kickoffFor, newsProject } from "@/lib/news/overlay";
import { MemoryNewsRepository } from "@/lib/news/repository";
import { MIN_ATTEMPT_GAP_MS, freshness, refreshNews, refreshTtlMs } from "@/lib/news/service";
import { SOURCE_RELIABILITY, parseFplNews, parseRss, rssAdapter, SOURCES } from "@/lib/news/sources";
import { emptyNewsState, type NewsItem, type NewsState, type RawArticle } from "@/lib/news/types";
import { buildHorizon } from "@/lib/season/horizon";
import { chipStrategy } from "@/lib/season/chips";
import { seasonValues } from "@/lib/strategies/seasonLong";
import { buildSeasonHorizon } from "@/lib/strategies/seasonLong";
import { NEXT_GW } from "./helpers";
import { by, ds, squadFrom } from "./seasonHelpers";

const NOW = new Date("2026-11-15T12:00:00Z");
const idx = buildPlayerIndex(ds);
const P = (n: string) => ds.players.find((p) => p.webName === n)!;
const rel = SOURCE_RELIABILITY;

let seq = 0;
function item(playerName: string, o: Partial<NewsItem> = {}): NewsItem {
  const p = P(playerName);
  return {
    id: `t${++seq}`, playerId: p.id, playerName, club: "", category: "injury", severity: "moderate", impact: "out",
    headline: `${playerName} news`, summary: "s", sourceId: "bbc-sport-pl", sourceName: "BBC Sport", sourceUrl: `https://www.bbc.co.uk/sport/${seq}`,
    publishedAt: "2026-11-14T10:00:00Z", retrievedAt: NOW.toISOString(), expectedReturnDate: null, status: "reported", confidence: 0.8,
    affectedGameweeks: [], evidence: "e", articleKey: `k${seq}`, ...o,
  };
}
const stateOf = (items: NewsItem[]): NewsState => ({ ...emptyNewsState(), items, lastSuccessAt: NOW.toISOString() });
const overlayOf = (items: NewsItem[]) => buildOverlay(stateOf(items), NOW)!;
const ctx = buildModelContext(ds, NEXT_GW);
const fit = ds.players.filter((p) => p.status === "a" && p.minutes > 600 && p.starts > 5);

describe("player identity matching", () => {
  it("matches full names, web names and unique surnames to real FPL ids", () => {
    const h = P("Haaland");
    expect(matchPlayer(`${h.firstName} ${h.secondName}`, idx).playerId).toBe(h.id);
    expect(matchPlayer("Haaland", idx).playerId).toBe(h.id);
    expect(matchPlayer("HAALAND", idx).playerId).toBe(h.id);
    const g = P("Groß");
    expect(matchPlayer("Gross", idx).playerId).toBe(g.id); // diacritics
  });
  it("never guesses: ambiguous names return candidates, not an id", () => {
    const counts = new Map<string, number[]>();
    for (const p of ds.players) counts.set(p.webName, [...(counts.get(p.webName) ?? []), p.id]);
    const dup = [...counts.entries()].find(([, v]) => v.length > 1);
    expect(dup).toBeTruthy();
    const m = matchPlayer(dup![0], idx);
    expect(m.playerId).toBeNull();
    expect(m.ambiguous).toBe(true);
    expect(m.candidates.length).toBeGreaterThan(1);
    // a club hint resolves it
    const club = by.get(dup![1][0])!.teamId;
    expect(matchPlayer(dup![0], idx, club).playerId).toBe(dup![1][0]);
  });
  it("returns no match for unknown names", () => {
    const m = matchPlayer("Zzyzx Quibble", idx);
    expect(m).toMatchObject({ playerId: null, ambiguous: false });
  });
});

describe("articles: duplicates, expiry, reliability", () => {
  const a = { url: "https://www.bbc.co.uk/sport/football/1?at=1", title: "Saka a doubt for Arsenal after training knock", publishedAt: "2026-11-14T09:00:00Z" };
  it("detects the same article by URL and syndicated copies by headline", () => {
    expect(isDuplicateArticle(a, { ...a, url: "https://bbc.co.uk/sport/football/1/#x" })).toBe(true);
    expect(isDuplicateArticle(a, { url: "https://other.com/x", title: "Saka a doubt for Arsenal after a training knock", publishedAt: "2026-11-14T15:00:00Z" })).toBe(true);
    expect(isDuplicateArticle(a, { url: "https://other.com/y", title: "Haaland scores hat-trick for City", publishedAt: "2026-11-14T15:00:00Z" })).toBe(false);
    expect(dedupeArticles([a, { ...a, url: "https://other.com/x" }, { ...a, url: "https://x.com/z", title: "Totally different story about transfers" }])).toHaveLength(2);
    expect(articleKey(a.url, a.title)).toBe(articleKey("https://bbc.co.uk/sport/football/1", a.title));
  });
  it("expires stale news but keeps an injury with a future return date active", () => {
    const old = item("Saka", { publishedAt: "2026-09-01T00:00:00Z" });
    expect(isActive(old, NOW)).toBe(false);
    const fresh = item("Saka", { publishedAt: "2026-11-13T00:00:00Z" });
    expect(isActive(fresh, NOW)).toBe(true);
    const dated = item("Saka", { publishedAt: "2026-09-01T00:00:00Z", expectedReturnDate: "2026-12-01" });
    expect(isActive(dated, NOW)).toBe(true);
    expect(expiresAt(item("Saka", { status: "speculative" }))).toBeLessThan(expiresAt(item("Saka", { status: "reported" })));
    expect(buildEvents([old], rel, NOW)[0].active).toBe(false);
  });
  it("has reliability metadata for every implemented source", () => {
    for (const s of SOURCES) { expect(s.reliability).toBeGreaterThan(0); expect(rel[s.id]).toBe(s.reliability); }
    expect(rel["fpl-official"]).toBeGreaterThan(rel["bbc-sport-pl"]);
  });
});

describe("events: independence, supersession, contradiction", () => {
  it("five articles from one source are ONE piece of evidence; distinct sources add up", () => {
    SOURCE_RELIABILITY["pub-a"] = 0.7; SOURCE_RELIABILITY["pub-b"] = 0.7;
    const same = Array.from({ length: 5 }, (_, i) => item("Saka", { sourceId: "pub-a", publishedAt: `2026-11-14T0${i}:00:00Z`, sourceUrl: `https://a.com/${i}` }));
    const one = buildEvents(same, rel, NOW)[0];
    expect(one.independentSources).toEqual(["pub-a"]);
    const two = buildEvents([...same, item("Saka", { sourceId: "pub-b", publishedAt: "2026-11-14T06:00:00Z" })], rel, NOW)[0];
    expect(two.independentSources.sort()).toEqual(["pub-a", "pub-b"]);
    expect(two.belief).toBeGreaterThan(one.belief);
    expect(two.items).toHaveLength(6); // every source reference is kept for inspection
    expect(one.belief).toBeCloseTo(0.7 * 0.6 * 0.8, 3); // reliability x status x confidence, counted once
  });
  it("a newer report supersedes an older one from the same source", () => {
    const older = item("Saka", { publishedAt: "2026-11-12T10:00:00Z", impact: "out", headline: "ruled out" });
    const newer = item("Saka", { publishedAt: "2026-11-14T10:00:00Z", impact: "fit", category: "training_update", headline: "back in training" });
    const ev = buildEvents([older, newer], rel, NOW)[0];
    expect(ev.current.id).toBe(newer.id);
  });
  it("flags contradictory reports from different reliable sources", () => {
    const out = item("Saka", { sourceId: "bbc-sport-pl", impact: "out", publishedAt: "2026-11-14T08:00:00Z" });
    const fitI = item("Saka", { sourceId: "fpl-official", impact: "fit", category: "training_update", status: "confirmed", publishedAt: "2026-11-14T09:00:00Z" });
    const ev = buildEvents([out, fitI], rel, NOW)[0];
    expect(ev.contradicted).toBe(true);
    expect(buildEvents([out], rel, NOW)[0].contradicted).toBe(false);
  });
  it("items awaiting identity review never become events", () => {
    expect(buildEvents([{ ...item("Saka"), playerId: null, needsReview: true }], rel, NOW)).toHaveLength(0);
  });
});

describe("availability engine", () => {
  const p = fit.find((x) => x.pos === "MID")!;
  const adj = (items: NewsItem[], gw = NEXT_GW, player = p) => {
    const evs = buildEvents(items.map((i) => ({ ...i, playerId: player.id })), rel, NOW);
    return adjustAvailability({ player, team: ds.teams[player.teamId], gw, nextId: ctx.nextId, kickoff: kickoffFor(ds, player.teamId, gw), events: evs, now: NOW });
  };
  const I = (o: Partial<NewsItem>) => item("Saka", o);

  it("a confirmed injury with a return date after the match means out; after the date it eases the player back in", () => {
    const k = kickoffFor(ds, p.teamId, NEXT_GW);
    const later = new Date(k.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    const r = adj([I({ status: "confirmed", sourceId: "fpl-official", confidence: 0.95, expectedReturnDate: later })])!;
    // not "representedInFpl", so it applies to the next gameweek
    expect(r.adjustedAvailability).toBeLessThan(0.15);
    expect(r.availabilityStatus).toMatch(/out|likely-out/);
    expect(r.reasonCodes).toContain("CONFIRMED_OUT_UNTIL_DATE");
    const past = new Date(k.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
    const back = adj([I({ status: "confirmed", sourceId: "fpl-official", confidence: 0.95, expectedReturnDate: past })]);
    expect(back === null || back.adjustedExpectedMinutes <= back.baseExpectedMinutes).toBe(true);
    if (back) expect(back.reasonCodes).toContain("RETURNING_FROM_ABSENCE");
  });
  it("a speculative injury moves less than a confirmed one and is never treated as fact", () => {
    const conf = adj([I({ status: "confirmed", sourceId: "fpl-official", confidence: 0.9 })])!;
    const spec = adj([I({ status: "speculative", confidence: 0.6 })])!;
    expect(spec.adjustedAvailability).toBeGreaterThan(conf.adjustedAvailability);
    expect(spec.adjustedAvailability).toBeGreaterThan(0.6);
    expect(spec.reasons.join(" ")).toMatch(/Not confirmed as unavailable/);
    expect(spec.reasonCodes).toContain("SPECULATIVE_OUT");
  });
  it("a reported fitness doubt cuts start probability but is not confirmed unavailable", () => {
    const r = adj([I({ impact: "doubt", category: "training_update", status: "reported", confidence: 0.8 })])!;
    expect(r.adjustedStartProbability).toBeLessThan(r.baseStartProbability);
    expect(r.adjustedAvailability).toBeGreaterThan(0.6);
    expect(r.reasons[0]).toMatch(/not confirmed unavailable/i);
  });
  it("undated absences fade with time and with lower severity", () => {
    const now = (sev: NewsItem["severity"], published: string) => adj([I({ severity: sev, publishedAt: published, status: "confirmed", sourceId: "fpl-official", confidence: 0.9 })])!.adjustedAvailability;
    expect(now("minor", "2026-11-14T10:00:00Z")).toBeGreaterThan(now("major", "2026-11-14T10:00:00Z"));
    expect(now("moderate", "2026-11-14T10:00:00Z")).toBeLessThan(now("moderate", "2026-11-14T10:00:00Z") + 1e-9);
    const early = adj([I({ severity: "minor", publishedAt: "2026-11-14T10:00:00Z", status: "confirmed", sourceId: "fpl-official", confidence: 0.9 })])!.adjustedAvailability;
    const decayed = adj([I({ severity: "minor", publishedAt: "2026-11-01T10:00:00Z", status: "confirmed", sourceId: "fpl-official", confidence: 0.9 })])!.adjustedAvailability;
    expect(decayed).toBeGreaterThan(early);
  });
  it("suspension keeps a player out until the return date and no longer", () => {
    const k = kickoffFor(ds, p.teamId, NEXT_GW);
    const until = new Date(k.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const r = adj([I({ category: "suspension", severity: "minor", status: "confirmed", sourceId: "fpl-official", confidence: 0.95, expectedReturnDate: until })])!;
    expect(r.adjustedAvailability).toBeLessThan(0.15);
    const gw12 = adj([I({ category: "suspension", severity: "minor", status: "confirmed", sourceId: "fpl-official", confidence: 0.95, expectedReturnDate: until })], NEXT_GW + 3);
    expect(gw12 === null || gw12.adjustedAvailability > 0.7).toBe(true);
  });
  it("rotation risk trims starts (minutes) without making the player unavailable", () => {
    const r = adj([I({ category: "rotation", impact: "reduced", status: "reported", confidence: 0.8 })])!;
    expect(r.adjustedAvailability).toBe(r.baseAvailability);
    expect(r.adjustedStartProbability).toBeLessThan(r.baseStartProbability);
    expect(r.adjustedExpectedMinutes).toBeLessThan(r.baseExpectedMinutes);
    expect(r.reasonCodes).toContain("ROTATION_RISK");
    expect(r.availabilityStatus).not.toBe("out");
  });
  it("international duty alone changes nothing; a late return costs minutes only for a match soon after", () => {
    const duty = adj([I({ category: "international_duty", impact: "none", status: "reported" })]);
    expect(duty).toBeNull();
    const k = kickoffFor(ds, p.teamId, NEXT_GW);
    const returnSoon = new Date(k.getTime() - 1 * 86_400_000).toISOString().slice(0, 10);
    const late = adj([I({ category: "late_return", impact: "reduced", status: "reported", expectedReturnDate: returnSoon, publishedAt: "2026-11-14T10:00:00Z" })])!;
    expect(late.adjustedExpectedMinutes).toBeLessThan(late.baseExpectedMinutes);
    expect(late.adjustedAvailability).toBe(late.baseAvailability);
    const returnLongAgo = new Date(k.getTime() - 12 * 86_400_000).toISOString().slice(0, 10);
    expect(adj([I({ category: "late_return", impact: "reduced", status: "reported", expectedReturnDate: returnLongAgo, publishedAt: "2026-11-14T10:00:00Z" })])).toBeNull();
  });
  it("does not double count what FPL already says for the next gameweek", () => {
    const hurt = { ...p, status: "d", chanceNext: 50 };
    const evs = buildEvents([item("Saka", { playerId: hurt.id, impact: "doubt", status: "reported", confidence: 0.8 })].map((i) => ({ ...i, playerId: hurt.id })), rel, NOW);
    const r = adjustAvailability({ player: hurt, team: ds.teams[hurt.teamId], gw: NEXT_GW, nextId: ctx.nextId, kickoff: kickoffFor(ds, hurt.teamId, NEXT_GW), events: evs, now: NOW });
    expect(r === null || r.adjustedAvailability <= 0.5 + 1e-9).toBe(true);
    if (r) expect(r.adjustedAvailability).toBe(0.5); // min(FPL, news), never FPL x news
    // FPL-sourced items never move the next gameweek
    const fplItem = item("Saka", { playerId: hurt.id, sourceId: "fpl-official", representedInFpl: true, status: "confirmed", confidence: 0.95, expectedReturnDate: "2026-12-30" });
    const e2 = buildEvents([fplItem], rel, NOW);
    expect(adjustAvailability({ player: hurt, team: ds.teams[hurt.teamId], gw: NEXT_GW, nextId: ctx.nextId, kickoff: kickoffFor(ds, hurt.teamId, NEXT_GW), events: e2, now: NOW })).toBeNull();
    // but its return date informs later gameweeks
    const later = adjustAvailability({ player: hurt, team: ds.teams[hurt.teamId], gw: NEXT_GW + 2, nextId: ctx.nextId, kickoff: kickoffFor(ds, hurt.teamId, NEXT_GW + 2), events: e2, now: NOW });
    expect(later?.adjustedAvailability ?? 1).toBeLessThan(0.2);
  });
  it("contradictory sources halve the effect and say so", () => {
    const out = item("Saka", { impact: "out", status: "confirmed", sourceId: "fpl-official", confidence: 0.9, publishedAt: "2026-11-14T08:00:00Z" });
    const fitI = item("Saka", { impact: "fit", category: "training_update", status: "reported", publishedAt: "2026-11-14T07:00:00Z" });
    const single = adj([out])!;
    const mixed = adj([out, fitI])!;
    expect(mixed.adjustedAvailability).toBeGreaterThan(single.adjustedAvailability);
    expect(mixed.reasonCodes).toContain("CONTRADICTORY_REPORTS");
  });
  it("is deterministic", () => {
    const items = [I({ status: "confirmed", sourceId: "fpl-official", confidence: 0.9 })];
    expect(adj(items)).toEqual(adj(items));
  });
});

describe("projection integration", () => {
  const star = fit.sort((a, b) => projectPlayer(b, ctx).ep - projectPlayer(a, ctx).ep)[0];
  const out = (p = star) => overlayOf([item("Saka", { playerId: p.id, playerName: p.webName, status: "confirmed", sourceId: "fpl-official", confidence: 0.95, severity: "major" })]);

  it("with no news the projection is EXACTLY the original (identity)", () => {
    for (const p of ds.players.slice(0, 120)) expect(newsProject(p, ctx, NEXT_GW, null)).toEqual(projectPlayer(p, ctx, NEXT_GW));
    const empty = buildOverlay(stateOf([]), NOW);
    expect(empty).toBeNull();
    const { ds: same, impacts } = applyNewsToDataset(ds, NEXT_GW, null);
    expect(same).toBe(ds);
    expect(impacts.size).toBe(0);
    // news about a player who does not change availability leaves everyone untouched
    const ov = overlayOf([item("Saka", { impact: "none", category: "other" })]);
    expect(applyNewsToDataset(ds, NEXT_GW, ov).ds).toBe(ds);
  });
  it("news-adjusted xPts come from the unchanged model fed lower availability, with the original kept for comparison", () => {
    const ov = out();
    const base = projectPlayer(star, ctx, NEXT_GW);
    const adjusted = newsProject(star, ctx, NEXT_GW, ov);
    expect(adjusted.ep).toBeLessThan(base.ep * 0.3);
    expect(adjusted.news).toMatchObject({ baseXpts: base.ep, newsAdjustedXpts: adjusted.ep });
    expect(adjusted.news!.adjustedExpectedMinutes).toBeLessThan(adjusted.news!.baseExpectedMinutes);
    expect(adjusted.news!.adjustmentReasons.length).toBeGreaterThan(0);
    expect(adjusted.news!.sources[0].url).toMatch(/^https?:\/\//);
    expect(adjusted.expMinutes).toBeLessThan(base.expMinutes);
    // components are produced by the model, not edited
    expect(adjusted.components.goals).toBeLessThan(base.components.goals);
  });
  it("dataset patch gives the frozen single-gameweek strategies the same adjusted projection", () => {
    const ov = out();
    const { ds: dsN, impacts } = applyNewsToDataset(ds, NEXT_GW, ov);
    expect(impacts.get(star.id)!.newsAdjustedXpts).toBeCloseTo(projectAll(dsN, NEXT_GW).byId.get(star.id)!.ep, 1);
    expect(dsN.players.find((p) => p.id === star.id)!.id).toBe(star.id);
    expect(ds.players.find((p) => p.id === star.id)!.chanceNext).toBe(star.chanceNext); // the original is never mutated
    const others = ds.players.filter((p) => p.id !== star.id).slice(0, 80);
    const a = projectAll(ds, NEXT_GW).byId, b = projectAll(dsN, NEXT_GW).byId;
    for (const p of others) expect(b.get(p.id)!.ep).toBe(a.get(p.id)!.ep);
  });
  it("Balanced stops picking a player ruled out, and picks him otherwise", () => {
    const base = optimizeSquad(ds, projectAll(ds, NEXT_GW, { mode: "balanced" }).byId, { mode: "balanced" }).result;
    const victim = base.starting[0];
    const v = by.get(victim)!;
    const { ds: dsN } = applyNewsToDataset(ds, NEXT_GW, out(v));
    const after = optimizeSquad(dsN, projectAll(dsN, NEXT_GW, { mode: "balanced" }).byId, { mode: "balanced" }).result;
    expect([...after.starting].includes(victim)).toBe(false);
  });
  it("captaincy changes when the captain is ruled out", () => {
    const base = optimizeSquad(ds, projectAll(ds, NEXT_GW, { mode: "balanced" }).byId, { mode: "balanced" }).result;
    const cap = by.get(base.captain)!;
    const { ds: dsN } = applyNewsToDataset(ds, NEXT_GW, out(cap));
    const after = optimizeSquad(dsN, projectAll(dsN, NEXT_GW, { mode: "balanced" }).byId, { mode: "balanced" }).result;
    expect(after.captain).not.toBe(base.captain);
  });
  it("later gameweeks use per-gameweek adjustment in the horizon (return date respected)", () => {
    const k = (g: number) => kickoffFor(ds, star.teamId, g);
    const ret = new Date(k(NEXT_GW + 1).getTime() + 86_400_000).toISOString().slice(0, 10); // back for GW+2
    const ov = overlayOf([item("Saka", { playerId: star.id, status: "confirmed", sourceId: "fpl-official", confidence: 0.95, expectedReturnDate: ret })]);
    const hz = buildHorizon(ds, NEXT_GW, 5, ov);
    const base = buildHorizon(ds, NEXT_GW);
    expect(hz.proj[0].get(star.id)!.ep).toBeLessThan(base.proj[0].get(star.id)!.ep * 0.3);
    expect(hz.proj[1].get(star.id)!.ep).toBeLessThan(base.proj[1].get(star.id)!.ep * 0.3);
    expect(hz.proj[3].get(star.id)!.ep).toBeGreaterThan(base.proj[3].get(star.id)!.ep * 0.7);
    expect(buildHorizon(ds, NEXT_GW, 5, null).proj[1].get(star.id)!.ep).toBe(base.proj[1].get(star.id)!.ep);
  });
  it("Season Long values an injured player lower and is unchanged without news", () => {
    const ov = overlayOf([item("Saka", { playerId: star.id, status: "confirmed", sourceId: "fpl-official", confidence: 0.95, severity: "major" })]);
    const h0 = buildSeasonHorizon(ds, NEXT_GW);
    const h1 = buildSeasonHorizon(ds, NEXT_GW, { news: ov });
    expect(seasonValues(ds, h1).get(star.id)!.value).toBeLessThan(seasonValues(ds, h0).get(star.id)!.value);
    expect(seasonValues(ds, buildSeasonHorizon(ds, NEXT_GW, { news: null })).get(star.id)!.value).toBe(seasonValues(ds, h0).get(star.id)!.value);
  });
});

describe("Bench Boost and chips use availability-adjusted projections", () => {
  const squad = squadFrom(optimizeSquad(ds, projectAll(ds, NEXT_GW).byId, { mode: "balanced" }).result.squad, { freeTransfers: 1 });
  it("bench boost gain falls when bench players are doubtful, with the risks listed and unadjusted gain shown", () => {
    const base = chipStrategy(ds, squad, NEXT_GW).find((c) => c.chip === "bboost")!;
    const hz0 = buildHorizon(ds, NEXT_GW);
    const bench = optimizeSquad(ds, projectAll(ds, NEXT_GW).byId, { mode: "balanced" }).result.bench;
    const items = bench.slice(0, 3).map((id) => item("Saka", { playerId: id, status: "confirmed", sourceId: "fpl-official", confidence: 0.95, severity: "major" }));
    const ov = overlayOf(items);
    const hz = buildHorizon(ds, NEXT_GW, 5, ov);
    const adv = chipStrategy(ds, squad, NEXT_GW, 0, hz).find((c) => c.chip === "bboost")!;
    expect(hz0.proj[0].size).toBe(hz.proj[0].size);
    expect(adv.available).toBe(true);
    expect(adv.nowGain).toBeLessThan(base.nowGain);
    expect(adv.availabilityRisks!.length).toBeGreaterThan(0);
    expect(adv.text).toMatch(/Availability risks/);
    const opt = adv.options.find((o) => o.gw === NEXT_GW)!;
    expect(opt.gainWithoutNews).toBeGreaterThan(opt.gain);
  });
  it("without news the chip advice is identical", () => {
    const a = chipStrategy(ds, squad, NEXT_GW, 0, buildHorizon(ds, NEXT_GW));
    const b = chipStrategy(ds, squad, NEXT_GW, 0, buildHorizon(ds, NEXT_GW, 5, null));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("extraction: the model never invents anything", () => {
  const art: RawArticle = {
    sourceId: "bbc-sport-pl", url: "https://www.bbc.co.uk/sport/football/articles/abc", title: "Haaland a doubt for Manchester City", summary: "Erling Haaland is a doubt for Saturday after missing training, manager Pep Guardiola said. Saka will be out for six weeks.",
    publishedAt: "2026-11-14T09:00:00Z", retrievedAt: NOW.toISOString(),
  };
  const good = { playerName: "Haaland", club: "Man City", category: "injury", severity: "minor", impact: "doubt", status: "confirmed", headline: "Haaland doubt", summary: "Missed training", expectedReturnDate: null, affectedGameweeks: [11], evidence: "Erling Haaland is a doubt for Saturday after missing training", confidence: 0.8 };
  it("accepts grounded items; ids, url and timestamps come from the article/dataset, never the model", () => {
    const out = validateLlmItems(JSON.stringify([{ ...good, playerId: 999999, sourceUrl: "https://evil.example", publishedAt: "2000-01-01" }]), art, ds, idx);
    expect(out).toHaveLength(1);
    expect(out[0].playerId).toBe(P("Haaland").id);
    expect(out[0].sourceUrl).toBe(art.url);
    expect(out[0].publishedAt).toBe(art.publishedAt);
    expect(out[0].status).toBe("reported"); // a publisher cannot "confirm" for the club
  });
  it("drops invented evidence, unnamed players, bad categories, and unsupported return dates", () => {
    const bad = [
      { ...good, evidence: "Haaland has been ruled out for the season with a broken leg" },
      { ...good, playerName: "Salah", evidence: "Erling Haaland is a doubt for Saturday" },
      { ...good, category: "made_up" },
      { ...good, expectedReturnDate: "2027-03-03" },
    ];
    const noDuration = { ...art, summary: "Erling Haaland is a doubt for Saturday after missing training, manager Pep Guardiola said." };
    const out = validateLlmItems(JSON.stringify(bad), noDuration, ds, idx);
    expect(out).toHaveLength(1);
    expect(out[0].expectedReturnDate).toBeNull(); // date not in the article -> removed, confidence capped
    expect(out[0].confidence).toBeLessThanOrEqual(0.5);
    expect(validateLlmItems("not json", art, ds, idx)).toEqual([]);
  });
  it("accepts a duration-derived return date when the article states a duration", () => {
    const art2 = { ...art, summary: "Saka will be out for six weeks with a hamstring injury, Arsenal confirmed." };
    const ok = validateLlmItems(JSON.stringify([{ ...good, playerName: "Saka", club: "Arsenal", impact: "out", expectedReturnDate: "2026-12-26", evidence: "Saka will be out for six weeks with a hamstring injury" }]), art2, ds, idx);
    expect(ok[0].expectedReturnDate).toBe("2026-12-26");
  });
  it("flags ambiguous players for review instead of attaching them", () => {
    const counts = new Map<string, number>();
    for (const p of ds.players) counts.set(p.webName, (counts.get(p.webName) ?? 0) + 1);
    const dup = [...counts.entries()].find(([, n]) => n > 1)![0];
    const art3 = { ...art, summary: `${dup} is a doubt for the weekend after a knock in training.` };
    const out = validateLlmItems(JSON.stringify([{ ...good, playerName: dup, club: null, evidence: `${dup} is a doubt for the weekend after a knock in training` }]), art3, ds, idx);
    expect(out[0].playerId).toBeNull();
    expect(out[0].needsReview).toBe(true);
    expect(out[0].candidates!.length).toBeGreaterThan(1);
  });
  it("the heuristic baseline extracts conservative reported/speculative items and never 'confirms'", async () => {
    const items = await heuristicExtractor.extract({ ...art, summary: "Erling Haaland is a doubt for Saturday after missing training. Bukayo Saka could be sidelined for six weeks." }, ds, idx);
    expect(items.find((i) => i.playerId === P("Haaland").id)).toMatchObject({ status: "reported", impact: "doubt" });
    expect(items.every((i) => i.status !== "confirmed")).toBe(true);
    const saka = items.find((i) => i.playerId === P("Saka").id);
    expect(saka?.status).toBe("speculative");
  });
  it("heuristic regressions seen on live BBC feeds: 'Forest' is not 'rest', and a keyword binds to one player", async () => {
    const forest = await heuristicExtractor.extract({ ...art, title: "Delap double inspires Forest to stunning win over Man City.", summary: "Liam Delap scored twice." }, ds, idx);
    expect(forest).toEqual([]);
    const sentOff = await heuristicExtractor.extract({ ...art, title: "Match report", summary: "Erling Haaland's strike fires City to a 2-0 win, but Bukayo Saka was sent off and is suspended for the next game." }, ds, idx);
    expect(sentOff.map((i) => i.playerId)).toEqual([P("Saka").id]);
    expect(await heuristicExtractor.extract({ ...art, title: "There is no doubt City will win", summary: "No doubt about it." }, ds, idx)).toEqual([]);
  });
  it("llmExtractor wires the validator; Gemini and Anthropic calls use server env keys and the right endpoints", async () => {
    const ext = llmExtractor(async () => JSON.stringify([good]));
    expect((await ext.extract(art, ds, idx))[0].playerId).toBe(P("Haaland").id);
    expect(geminiCall({})).toBeNull();
    expect(anthropicCall({})).toBeNull();
    const f = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }), { status: 200 }));
    const call = geminiCall({ GEMINI_API_KEY: "k", NEWS_LLM_MODEL: "gemini-x" }, f as unknown as typeof fetch)!;
    expect(await call("sys", "usr")).toBe("[]");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/models/gemini-x:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    expect(url).not.toContain("k=k"); // the key is a header, never in the URL
    const d = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200 }));
    const dc = deepseekCall({ DEEPSEEK_API_KEY: "dk" }, d as unknown as typeof fetch)!;
    expect(await dc("sys", "usr")).toBe("[]");
    const [durl, dinit] = d.mock.calls[0] as unknown as [string, RequestInit];
    expect(durl).toBe("https://api.deepseek.com/chat/completions");
    expect((dinit.headers as Record<string, string>).authorization).toBe("Bearer dk");
    expect(deepseekCall({})).toBeNull();
    const bad = geminiCall({ GEMINI_API_KEY: "k" }, (async () => new Response("no", { status: 500 })) as typeof fetch)!;
    await expect(bad("a", "b")).rejects.toThrow(/500/);
  });
});

describe("source parsing", () => {
  it("parses official FPL status text into structured items", () => {
    const sus = parseFplNews({ ...P("Saka"), news: "Suspended until 29 Nov", newsAdded: "2026-10-27T22:30:00Z", status: "s" }, NOW.toISOString())!;
    expect(sus).toMatchObject({ category: "suspension", impact: "out", status: "confirmed", expectedReturnDate: "2026-11-29", representedInFpl: true });
    const inj = parseFplNews({ ...P("Saka"), news: "Knee injury - 75% chance of playing", newsAdded: "2026-11-10T00:00:00Z", status: "d" }, NOW.toISOString())!;
    expect(inj).toMatchObject({ category: "injury", impact: "doubt" });
    const unk = parseFplNews({ ...P("Saka"), news: "Thigh injury - Unknown return date", newsAdded: "2026-10-21T00:00:00Z", status: "i" }, NOW.toISOString())!;
    expect(unk).toMatchObject({ impact: "out", severity: "moderate", expectedReturnDate: null });
    const gone = parseFplNews({ ...P("Saka"), news: "Has joined Al Hilal permanently", newsAdded: "2026-09-04T00:00:00Z", status: "u" }, NOW.toISOString())!;
    expect(gone).toMatchObject({ impact: "none", category: "other" });
    expect(parseFplNews({ ...P("Saka"), news: "" }, NOW.toISOString())).toBeNull();
  });
  it("parses RSS (headline, link, summary, date) and skips malformed entries", () => {
    const xml = `<rss><channel><item><title><![CDATA[Saka &amp; co: injury latest]]></title><link>https://www.bbc.co.uk/sport/football/articles/1</link><description><![CDATA[<p>Saka is a doubt.</p>]]></description><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate></item><item><title>No link</title></item></channel></rss>`;
    const a = parseRss(xml, "bbc-sport-pl", NOW.toISOString());
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ title: "Saka & co: injury latest", summary: "Saka is a doubt.", publishedAt: "2026-11-14T10:00:00.000Z" });
  });
});

describe("refresh strategy, caching and failure handling", () => {
  const okAdapter = (articles: RawArticle[]) => ({ meta: SOURCES[1], fetch: async () => ({ articles }) });
  const art = (n: number): RawArticle => ({ sourceId: "bbc-sport-pl", url: `https://www.bbc.co.uk/sport/football/articles/${n}`, title: `Erling Haaland is a doubt for the weekend ${n}`, summary: "Erling Haaland is a doubt after missing training.", publishedAt: "2026-11-14T09:00:00Z", retrievedAt: NOW.toISOString() });

  it("refreshes, stores extracted items and never sends the same article twice", async () => {
    const repo = new MemoryNewsRepository();
    const extractor = { name: "x", extract: vi.fn(async () => []) };
    const r1 = await refreshNews({ ds, repo, adapters: [okAdapter([art(1)])], extractor, now: NOW, force: true });
    expect(r1.refreshed).toBe(true);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    const later = new Date(NOW.getTime() + 2 * MIN_ATTEMPT_GAP_MS);
    await refreshNews({ ds, repo, adapters: [okAdapter([art(1)])], extractor, now: later, force: true });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });
  it("rate-limits attempts (even manual) and skips refreshes while fresh", async () => {
    const repo = new MemoryNewsRepository();
    const ad = { meta: SOURCES[1], fetch: vi.fn(async () => ({ articles: [] })) };
    await refreshNews({ ds, repo, adapters: [ad], now: NOW, force: true });
    const again = await refreshNews({ ds, repo, adapters: [ad], now: new Date(NOW.getTime() + 5_000), force: true });
    expect(again).toMatchObject({ refreshed: false, reason: "rate-limited" });
    const notYet = await refreshNews({ ds, repo, adapters: [ad], now: new Date(NOW.getTime() + 2 * MIN_ATTEMPT_GAP_MS) });
    expect(notYet).toMatchObject({ refreshed: false, reason: "fresh" });
    expect(ad.fetch).toHaveBeenCalledTimes(1);
  });
  it("survives a failing source, records it, and keeps the data from the working one", async () => {
    const repo = new MemoryNewsRepository();
    const bad = { meta: { ...SOURCES[1], id: "broken", name: "Broken" }, fetch: async () => { throw new Error("feed returned 503"); } };
    const good = { meta: SOURCES[0], fetch: async () => ({ items: [item("Saka", { sourceId: "fpl-official" })] }) };
    const r = await refreshNews({ ds, repo, adapters: [bad, good], now: NOW, force: true });
    expect(r.refreshed).toBe(true);
    expect(r.failed).toEqual(["broken"]);
    expect(r.state.sourceStatus.broken).toMatchObject({ ok: false, error: expect.stringContaining("503") });
    expect(r.state.items).toHaveLength(1);
  });
  it("when every source fails nothing is claimed live", async () => {
    const repo = new MemoryNewsRepository();
    const bad = { meta: SOURCES[1], fetch: async () => { throw new Error("down"); } };
    const r = await refreshNews({ ds, repo, adapters: [bad], now: NOW, force: true });
    expect(r).toMatchObject({ refreshed: false, reason: "all-sources-failed" });
    expect(freshness(r.state, ds, NOW).label).toBe("never");
  });
  it("labels news stale (never 'live') once the last successful refresh is old", () => {
    const s = { ...emptyNewsState(), lastSuccessAt: "2026-11-13T00:00:00Z" };
    expect(freshness(s, ds, NOW).label).toBe("stale");
    expect(freshness({ ...s, lastSuccessAt: new Date(NOW.getTime() - 60_000).toISOString() }, ds, NOW).label).toBe("live");
  });
  it("refreshes more often as the deadline approaches", () => {
    const next = ds.events.find((e) => e.isNext)!;
    const dl = Date.parse(next.deadline);
    const t = (hoursBefore: number) => refreshTtlMs(ds, new Date(dl - hoursBefore * 3_600_000));
    expect(t(100)).toBeGreaterThan(t(48));
    expect(t(48)).toBeGreaterThan(t(12));
    expect(t(12)).toBeGreaterThan(t(3));
  });
  it("the rss adapter reports HTTP errors", async () => {
    const ad = rssAdapter(SOURCES[1], "https://x.test/rss", (async () => new Response("", { status: 503 })) as typeof fetch);
    await expect(ad.fetch({ ds, now: NOW })).rejects.toThrow(/503/);
  });
});

describe("news feed for the UI", () => {
  it("returns de-duplicated events with every source link, freshness and review items", () => {
    SOURCE_RELIABILITY["pub-a"] = 0.7;
    const star = fit[0];
    const items = [
      item("Saka", { playerId: star.id, sourceId: "pub-a", status: "confirmed", confidence: 0.9, sourceUrl: "https://a.com/1" }),
      item("Saka", { playerId: star.id, sourceId: "bbc-sport-pl", sourceUrl: "https://www.bbc.co.uk/sport/2" }),
      { ...item("Saka"), playerId: null, needsReview: true, reviewReason: "2 players share the surname", playerName: "Silva" },
    ];
    const feed = buildFeed(ds, stateOf(items), NEXT_GW, NOW);
    const ev = feed.events.find((e) => e.playerId === star.id)!;
    expect(feed.events.filter((e) => e.playerId === star.id)).toHaveLength(1);
    expect(ev.sources.map((s) => s.url).sort()).toEqual(["https://a.com/1", "https://www.bbc.co.uk/sport/2"]);
    expect(ev.impact!.newsAdjustedXpts).toBeLessThan(ev.impact!.baseXpts);
    expect(feed.review).toHaveLength(1);
    expect(feed.freshness.label).toBe("live");
    expect(buildFeed(ds, stateOf(items), NEXT_GW, NOW, { ids: new Set([-1]) }).events).toHaveLength(0);
  });
});

describe("overlay object", () => {
  it("only active events with evidence create overlay entries", () => {
    expect(buildOverlay(stateOf([item("Saka", { publishedAt: "2026-08-01T00:00:00Z" })]), NOW)).toBeNull();
    const ov = overlayOf([item("Saka")]);
    expect(ov).toBeInstanceOf(NewsOverlay);
    expect(ov.has(P("Saka").id)).toBe(true);
  });
});
