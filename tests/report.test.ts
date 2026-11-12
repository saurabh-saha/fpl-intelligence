import { beforeAll, describe, expect, it, vi } from "vitest";
import { NEXT_GW } from "./helpers";
import { by, ds, mediocreSquad, swapCandidates } from "./seasonHelpers";
import { compact, embeddedJson, pdfInfo, textJson } from "./pdfHelpers";

vi.mock("@/lib/fpl/client", () => ({
  getDataset: async () => (await import("./helpers")).sampleDataset(),
  getElementSummary: async () => null,
}));

const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
let generated: any;
let report: typeof import("@/app/api/report/route");

async function pdf(body: unknown) {
  const res = await report.POST(post(body));
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}
const builderBody = (s: any, extra: object = {}) => ({ kind: "builder", gw: NEXT_GW, mode: "balanced", starting: s.starting.map((p: any) => p.id), bench: s.bench.map((p: any) => p.id), captain: s.captain, vice: s.viceCaptain, ...extra });

beforeAll(async () => {
  report = await import("@/app/api/report/route");
  const { POST } = await import("@/app/api/optimize/route");
  generated = await (await POST(post({ gw: NEXT_GW, mode: "balanced" }))).json();
});

describe("GW report PDF: Team Builder", () => {
  it("returns a real PDF with metadata, selectable text and an attached JSON file", async () => {
    const { res, buf } = await pdf(builderBody(generated, { originalIds: generated.squadIds }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("fpl-gw11-builder-report.pdf");
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const info = await pdfInfo(buf);
    expect(info.numPages).toBeGreaterThan(5);
    expect(info.title).toBe("Gameweek 11 Intelligence Report");
    expect(info.subject).toContain("captain");
    expect(info.attachmentNames).toContain("fpl-gw11-report.json");
    expect(info.text.length).toBeGreaterThan(20000);
  });

  it("contains all 15 players, XI, bench, captain, vice, stats, xPts, fixtures and confidence as text", async () => {
    const { buf } = await pdf(builderBody(generated));
    const { text } = await pdfInfo(buf);
    const all = [...generated.starting, ...generated.bench];
    expect(all).toHaveLength(15);
    for (const p of all) {
      expect(text, p.name).toContain(p.name);
      expect(text, `xPts ${p.name}`).toContain(p.ep.toFixed(2));
    }
    expect(text).toContain("Starting XI (4-3-3)");
    expect(text).toContain("Bench (in substitution order)");
    const cap = all.find((p: any) => p.id === generated.captain);
    const vice = all.find((p: any) => p.id === generated.viceCaptain);
    expect(text).toContain(`${cap.name} (C)`);
    expect(text).toContain(`${vice.name} (V)`);
    for (const h of ["Expected-points breakdown", "Fixtures and expected points: next five gameweeks", "Why each player is in the squad", "Replacement shortlist", "Model, confidence and known limitations", "Structured data (machine-readable)"]) expect(text, h).toContain(h);
    for (const f of generated.starting[0].fixtures) expect(text).toContain(`${f.oppShort}(${f.home ? "H" : "A"}) FDR${f.difficulty}`);
    expect(text).toMatch(/Model confidence/);
    expect(text).toMatch(/high \(\d+\)/);
    expect(text).toContain("FACT = real FPL data");
    expect(text).toContain("MODEL = this app's prediction");
    expect(text).toContain(`FPL API fetched ${ds.fetchedAt === "" ? "" : ""}`.trim());
  });

  it("embeds structured JSON that matches the printed text exactly and has complete player data", async () => {
    const { buf } = await pdf(builderBody(generated));
    const { text } = await pdfInfo(buf);
    const json = embeddedJson(buf);
    expect(json.schema).toBe("fpl-gw-report/1");
    // the JSON printed as text is the same document as the attachment
    expect(textJson(text)).toBe(compact(json));
    expect(json.players).toHaveLength(15);
    expect(json.players.filter((p: any) => p.role === "starting")).toHaveLength(11);
    expect(json.players.filter((p: any) => p.role === "bench").map((p: any) => p.benchOrder)).toEqual([1, 2, 3, 4]);
    expect(json.players.filter((p: any) => p.isCaptain)).toHaveLength(1);
    expect(json.players.filter((p: any) => p.isViceCaptain)).toHaveLength(1);
    for (const p of json.players) {
      for (const k of ["id", "name", "club", "position", "priceM", "ownershipPct", "status", "season", "projection", "upcomingFiveGws", "whySelected", "warnings"]) expect(p, `${p.name}.${k}`).toHaveProperty(k);
      expect(Object.keys(p.projection.breakdown).sort()).toEqual(["appearance", "assists", "cleanSheet", "defContrib", "bonus", "cards", "formAdj", "goals", "goalsConceded", "saves"].sort());
      expect(p.upcomingFiveGws).toHaveLength(5);
      expect(["high", "medium", "low"]).toContain(p.projection.confidence);
      const sum = Object.values(p.projection.breakdown as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - p.projection.xPts)).toBeLessThan(0.1);
    }
    expect(json.squad.modelConfidence.counts.high + json.squad.modelConfidence.counts.medium + json.squad.modelConfidence.counts.low).toBe(15);
    expect(json.model.limitations.length).toBeGreaterThan(2);
    expect(json.dataFreshness.fetchedAt).toBeTruthy();
    expect(json.transferRecommendations.replacementShortlist).toBeTruthy();
  });

  it("describes EXACTLY the squad on screen: a manually edited squad is reported as edited, never regenerated", async () => {
    const squad = generated.squadIds as number[];
    const outId = generated.starting.find((p: any) => p.pos === "MID" && p.id !== generated.captain).id;
    const { POST: alt } = await import("@/app/api/alternatives/route");
    const a = await (await alt(post({ gw: NEXT_GW, squad, playerId: outId }))).json();
    const pick = a.alternatives[Math.min(8, a.alternatives.length - 1)];
    const { POST: evalRoute } = await import("@/app/api/evaluate/route");
    const edited = await (await evalRoute(post({ gw: NEXT_GW, squad: squad.map((id) => (id === outId ? pick.playerId : id)), mode: "balanced" }))).json();
    expect(edited.squadIds).toContain(pick.playerId);
    // a fresh optimisation would NOT contain this player
    expect(generated.squadIds).not.toContain(pick.playerId);

    const { res, buf } = await pdf(builderBody(edited, { originalIds: squad }));
    expect(res.headers.get("x-report-squad")).toBe([...edited.starting, ...edited.bench].map((p: any) => p.id).join(","));
    const json = embeddedJson(buf);
    expect(json.players.map((p: any) => p.id)).toEqual([...edited.starting, ...edited.bench].map((p: any) => p.id));
    expect(json.squad.startingXI).toEqual(edited.starting.map((p: any) => p.id));
    expect(json.squad.bench).toEqual(edited.bench.map((p: any) => p.id));
    expect(json.squad.captainId).toBe(edited.captain);
    expect(json.squad.viceCaptainId).toBe(edited.viceCaptain);
    expect(json.squad.projectedPoints).toBeCloseTo(edited.expectedPoints, 1); // same number the screen shows
    expect(json.squad.totalCostM).toBeCloseTo(edited.totalCost, 5);
    expect(json.userEditsVsGeneratedSquad.added).toEqual([by.get(pick.playerId)!.webName]);
    expect(json.userEditsVsGeneratedSquad.removed).toEqual([by.get(outId)!.webName]);
    const { text } = await pdfInfo(buf);
    expect(text).toContain("User edits vs the generated squad");
    expect(text).toContain(by.get(pick.playerId)!.webName);
  });

  it("rejects squads that break FPL rules or malformed requests", async () => {
    const ids = [...generated.starting, ...generated.bench].map((p: any) => p.id);
    expect((await report.POST(post({ ...builderBody(generated), starting: ids.slice(0, 10) }))).status).toBe(400);
    expect((await report.POST(post({ ...builderBody(generated), kind: "nope" }))).status).toBe(400);
    expect((await report.POST(post({ ...builderBody(generated), captain: generated.bench[0].id }))).status).toBe(422);
    expect((await report.POST(post({ ...builderBody(generated), budget: 60 }))).status).toBe(422);
    const clubs = ds.players.filter((p) => p.pos === "MID" && p.status === "a").reduce<Record<number, number[]>>((m, p) => ((m[p.teamId] ??= []).push(p.id), m), {});
    const four = Object.values(clubs).find((v) => v.length >= 4)!;
    const bad = [...ids];
    const mids = bad.map((id, i) => (by.get(id)!.pos === "MID" ? i : -1)).filter((i) => i >= 0);
    four.slice(0, 4).forEach((id, k) => (bad[mids[k]] = id));
    const r = await report.POST(post({ ...builderBody(generated), starting: bad.slice(0, 11), bench: bad.slice(11) }));
    expect([422]).toContain(r.status);
  });
});

describe("GW report PDF: My Team", () => {
  const squad = mediocreSquad({ freeTransfers: 1 });
  const season = { source: "import", actual: squad, plans: {} as Record<number, any> };
  const out = squad.holdings.find((h) => by.get(h.id)!.pos === "FWD")!.id;
  let evalRoute: typeof import("@/app/api/season/evaluate/route");

  async function ev(plans: Record<number, any>) {
    evalRoute ??= await import("@/app/api/season/evaluate/route");
    return (await (await evalRoute.POST(post({ season: { ...season, plans }, gw: NEXT_GW }))).json()) as any;
  }
  const body = (e: any, plans: Record<number, any>, extra: object = {}) => ({
    kind: "my-team", season: { ...season, plans }, gw: NEXT_GW, teamName: "Demo FC", ftDerived: true,
    starting: e.proposed.starting.map((p: any) => p.id), bench: e.proposed.bench.map((p: any) => p.id), captain: e.proposed.captain, vice: e.proposed.viceCaptain, ...extra,
  });

  it("reports the PROPOSED squad (with the accepted transfer) and also lists the ACTUAL squad", async () => {
    const { POST: alt } = await import("@/app/api/season/alternatives/route");
    const a = await (await alt(post({ season, gw: NEXT_GW, playerId: out }))).json();
    const best = a.alternatives[0];
    const plans = { [NEXT_GW]: { transfers: [{ out, in: best.playerId }] } };
    const e = await ev(plans);
    expect(e.plan.valid).toBe(true);
    const { res, buf } = await pdf(body(e, plans));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("my-team");
    const json = embeddedJson(buf);
    const proposedIds = [...e.proposed.starting, ...e.proposed.bench].map((p: any) => p.id);
    expect(json.players.map((p: any) => p.id)).toEqual(proposedIds);
    expect(proposedIds).toContain(best.playerId);
    expect(proposedIds).not.toContain(out);
    // actual squad is the unchanged one
    expect(json.season.actualSquad.playerIds).toEqual(squad.holdings.map((h) => h.id));
    expect(json.season.actualSquad.playerIds).toContain(out);
    expect(json.season.proposedPlan.transfers).toHaveLength(1);
    expect(json.season.proposedPlan.transfers[0]).toMatchObject({ sellId: out, buyId: best.playerId, sell: by.get(out)!.webName, buy: by.get(best.playerId)!.webName });
    expect(json.season.proposedPlan.projectedPoints).toBeCloseTo(e.proposed.expectedPoints, 1);
    expect(json.season.proposedPlan.valid).toBe(true);
    expect(json.season.freeTransfersAvailable).toBe(1);
    expect(json.season.freeTransfersAreDerived).toBe(true);
    // purchase / selling prices for the actual squad
    expect(json.season.actualSquad.players.every((p: any) => p.sellingPriceM <= p.purchasePriceM + 5 && p.purchasePriceM > 0)).toBe(true);
    // recommendations + chips
    expect(["save", "transfer", "hit"]).toContain(json.transferRecommendations.decision);
    expect(json.transferRecommendations.options.length).toBeGreaterThan(2);
    expect(json.chipStrategy).toHaveLength(4);
    const { text } = await pdfInfo(buf);
    for (const h of ["Actual squad vs proposed plan (My Team)", "Transfer recommendations (MODEL)", "Chip strategy (MODEL)"]) expect(text, h).toContain(h);
    expect(text).toContain(by.get(best.playerId)!.webName);
    expect(text).toContain("Demo FC");
    expect(textJson(text)).toBe(compact(json));
    const picked = json.players.find((p: any) => p.id === squad.holdings.find((h) => h.id !== out)!.id);
    expect(picked.purchasePriceM).toBeGreaterThan(0);
    expect(picked.sellingPriceM).toBeGreaterThan(0);
  });

  it("with no plan the proposed squad equals the actual squad", async () => {
    const e = await ev({});
    const { buf } = await pdf(body(e, {}));
    const json = embeddedJson(buf);
    expect([...json.players.map((p: any) => p.id)].sort()).toEqual(squad.holdings.map((h) => h.id).sort());
    expect(json.season.proposedPlan.transfers).toHaveLength(0);
    expect(json.season.proposedPlan.hitCost).toBe(0);
  });

  it("a Free Hit plan reports the temporary squad as proposed while the actual squad stays intact", async () => {
    const { POST: fh } = await import("@/app/api/season/freehit/route");
    const f = await (await fh(post({ season, gw: NEXT_GW }))).json();
    const plans = { [NEXT_GW]: { transfers: [], chip: "freehit", freeHitIds: f.ids } };
    const e = await ev(plans);
    const { buf } = await pdf(body(e, plans));
    const json = embeddedJson(buf);
    expect([...json.players.map((p: any) => p.id)].sort()).toEqual([...f.ids].sort());
    expect(json.season.chipPlannedThisGameweek).toBe("freehit");
    expect(json.season.actualSquad.playerIds).toEqual(squad.holdings.map((h) => h.id));
  });

  it("Bench Boost is reflected in the projected points", async () => {
    const plans = { [NEXT_GW]: { transfers: [], chip: "bboost" } };
    const e = await ev(plans);
    const { buf } = await pdf(body(e, plans));
    const json = embeddedJson(buf);
    expect(json.season.chipPlannedThisGameweek).toBe("bboost");
    expect(json.squad.projectedPoints).toBeCloseTo(e.proposed.expectedPoints, 1);
    expect(json.squad.projectedPoints).toBeGreaterThan(json.season.actualSquad.projectedPointsWithNoChanges + 3);
  });

  it("refuses (409) when the squad on screen no longer matches the plan, instead of describing another squad", async () => {
    const e = await ev({});
    const stale = body(e, {}, { bench: [...e.proposed.bench.map((p: any) => p.id)].reverse() });
    expect((await report.POST(post(stale))).status).toBe(409);
    const wrongCaptain = body(e, {}, { captain: e.proposed.viceCaptain, vice: e.proposed.captain });
    expect((await report.POST(post(wrongCaptain))).status).toBe(409);
  });
});
