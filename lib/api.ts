import { NextResponse } from "next/server";
import { getDataset } from "./fpl/client";
import { annotateProjections, applyNewsToDataset } from "./news/overlay";
import { loadOverlay } from "./news/service";
import { nextGameweek } from "./fpl/normalizer";
import { projectAll } from "./analytics/playerScoring";
import { OptimizerError } from "./optimizer/squadOptimizer";
import type { Dataset, Mode, Player, Preferences, Projection, SquadResult } from "./fpl/types";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function fail(err: unknown) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  const message = err instanceof Error ? err.message : "Unexpected error";
  // Optimiser infeasibility is a client-correctable condition.
  const status = err instanceof OptimizerError ? 422 : 500;
  return NextResponse.json({ error: message }, { status });
}

export function parseGw(raw: unknown, ds: Dataset): number {
  if (raw === undefined || raw === null || raw === "") return nextGameweek(ds.events).id;
  const gw = Number(raw);
  if (!Number.isInteger(gw) || !ds.events.some((e) => e.id === gw)) throw new HttpError(400, `Unknown gameweek "${raw}".`);
  return gw;
}

const MODES: Mode[] = ["balanced", "safe", "aggressive"];

export function parsePrefs(raw: any, ds: Dataset): Preferences {
  const r = raw ?? {};
  const mode: Mode = MODES.includes(r.mode) ? r.mode : "balanced";
  const prefs: Preferences = { mode };
  if (r.budget !== undefined && r.budget !== null && r.budget !== "") {
    const b = Number(r.budget);
    if (!Number.isFinite(b) || b < 30 || b > 200) throw new HttpError(400, "budget must be in £m between 30 and 200.");
    prefs.budgetTenths = Math.min(Math.round(b * 10), ds.rules.budgetTenths);
  }
  if (r.formation) {
    if (!/^\d-\d-\d$/.test(String(r.formation))) throw new HttpError(400, "formation must look like 3-4-3.");
    prefs.formation = String(r.formation);
  }
  if (r.differential !== undefined && r.differential !== null && r.differential !== "") {
    const d = Number(r.differential);
    if (!Number.isFinite(d) || d < 0 || d > 1) throw new HttpError(400, "differential must be between 0 and 1.");
    prefs.differential = d;
  }
  if (r.maxOwnership !== undefined && r.maxOwnership !== null && r.maxOwnership !== "") {
    const m = Number(r.maxOwnership);
    if (!Number.isFinite(m) || m <= 0 || m > 100) throw new HttpError(400, "maxOwnership must be a percentage between 0 and 100.");
    prefs.maxOwnership = m;
  }
  if (r.favourFixtureRuns) prefs.favourFixtureRuns = true;
  return prefs;
}

export async function context(gwRaw: unknown, prefsRaw?: unknown) {
  const ds = await getDataset();
  const gw = parseGw(gwRaw, ds);
  const prefs = parsePrefs(prefsRaw, ds);
  // News intelligence: availability-adjusted dataset for this gameweek (the SAME dataset object when there is no relevant news).
  const overlay = await loadOverlay({ disabled: (prefsRaw as { news?: unknown } | undefined)?.news === false });
  const { ds: dsN, impacts } = applyNewsToDataset(ds, gw, overlay);
  const { byId, ctx } = projectAll(dsN, gw, prefs);
  annotateProjections(byId, impacts);
  return { ds: dsN, gw, prefs, proj: byId, ctx, news: { applied: impacts.size, impacts } };
}

export function freshness(ds: Dataset) {
  return { fetchedAt: ds.fetchedAt, source: ds.source, stale: ds.stale };
}

/** Compact player+projection record sent to the UI. */
export function view(p: Player, pr: Projection, ds: Dataset) {
  const team = ds.teams[p.teamId];
  return {
    id: p.id,
    name: p.webName,
    fullName: `${p.firstName} ${p.secondName}`.trim(),
    teamId: p.teamId,
    team: team?.short ?? "?",
    teamName: team?.name ?? "?",
    pos: p.pos,
    cost: p.cost,
    costTenths: p.costTenths,
    photoUrl: p.photoUrl,
    badgeUrl: team?.badgeUrl,
    status: p.status,
    news: p.news,
    ownership: p.ownership,
    form: p.form,
    ppg: p.ppg,
    totalPoints: p.totalPoints,
    minutes: p.minutes,
    starts: p.starts,
    goals: p.goals,
    assists: p.assists,
    xG: round(p.xG),
    xA: round(p.xA),
    xGI: round(p.xGI),
    cleanSheets: p.cleanSheets,
    saves: p.saves,
    bonus: p.bonus,
    ep: pr.ep,
    score: pr.score,
    confidence: pr.confidence,
    confidenceScore: pr.confidenceScore,
    startProb: pr.startProb,
    availability: pr.availability,
    expMinutes: pr.expMinutes,
    fixtures: pr.fixtures,
    components: pr.components,
    warnings: pr.warnings,
    reasons: pr.reasons,
    newsImpact: pr.news,
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

export type PlayerView = ReturnType<typeof view>;

export function squadView(ds: Dataset, proj: Map<number, Projection>, r: SquadResult) {
  const byId = new Map(ds.players.map((p) => [p.id, p]));
  const mk = (id: number) => view(byId.get(id)!, proj.get(id)!, ds);
  return {
    formation: r.formation,
    captain: r.captain,
    viceCaptain: r.viceCaptain,
    starting: r.starting.map(mk),
    bench: r.bench.map(mk),
    squadIds: r.squad,
    totalCost: r.totalCostTenths / 10,
    remaining: r.remainingTenths / 10,
    expectedPoints: r.expectedPoints,
  };
}

export async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function parseIds(raw: unknown, what = "squad"): number[] {
  if (!Array.isArray(raw) || raw.some((x) => !Number.isInteger(x))) throw new HttpError(400, `${what} must be an array of player ids.`);
  return raw as number[];
}

export type SquadView = ReturnType<typeof squadView>;

/* ---------------- season manager helpers ---------------- */
import type { SeasonState } from "./season/types";

export function parseSeason(raw: any): SeasonState {
  const s = raw?.season;
  if (!s || typeof s !== "object" || !s.actual || !Array.isArray(s.actual.holdings)) throw new HttpError(400, "season state is required (actual squad with holdings).");
  if (!Number.isInteger(s.actual.gw)) throw new HttpError(400, "season.actual.gw must be an integer.");
  for (const h of s.actual.holdings) if (!Number.isInteger(h?.id) || !Number.isInteger(h?.buyTenths)) throw new HttpError(400, "each holding needs integer id and buyTenths.");
  if (!Number.isInteger(s.actual.bankTenths) || !Number.isInteger(s.actual.freeTransfers) || s.actual.freeTransfers < 0) throw new HttpError(400, "bankTenths and freeTransfers must be integers.");
  return {
    version: 1,
    source: s.source ?? "manual",
    actual: { ...s.actual, chipsUsed: Array.isArray(s.actual.chipsUsed) ? s.actual.chipsUsed : [] },
    plans: s.plans && typeof s.plans === "object" ? s.plans : {},
    snapshots: [],
    recs: [],
    actualHistory: [],
    warnings: [],
    updatedAt: s.updatedAt ?? "",
  } as SeasonState;
}
