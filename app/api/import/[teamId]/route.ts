import { NextResponse } from "next/server";
import { getDataset, getElementSummary } from "@/lib/fpl/client";
import { fail, HttpError } from "@/lib/api";
import { chipFromFpl, reconstructHoldings, simulateFreeTransfers, type RawTransfer } from "@/lib/season/importer";
import type { ChipUse, SeasonState } from "@/lib/season/types";

export const dynamic = "force-dynamic";
const BASE = "https://fantasy.premierleague.com/api";

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; fpl-intelligence/1.0)" }, signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `FPL API returned ${res.status}.`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(503, "FPL is updating right now (non-JSON response). Try again in a few minutes.");
  }
}

/**
 * GET /api/import/{teamId}: reads only PUBLIC FPL endpoints (entry, history, transfers, picks).
 * No login or password is ever requested. Fields the API does not expose (free transfers, purchase
 * prices of the opening squad) are derived and listed in `derived` so the UI can offer manual override.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  try {
    const { teamId } = await params;
    const id = Number(teamId);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Team ID must be a positive number (find it in the URL of your FPL points page).");
    const ds = await getDataset();
    const [entry, history, transfersRaw] = await Promise.all([getJson(`${BASE}/entry/${id}/`), getJson(`${BASE}/entry/${id}/history/`), getJson(`${BASE}/entry/${id}/transfers/`)]);
    if (!entry || !history) throw new HttpError(404, `No FPL team found with ID ${id}.`);

    const currentEvent: number = ds.events.find((e) => e.isCurrent)?.id ?? entry.current_event;
    const nextEvent = ds.events.find((e) => e.isNext)?.id ?? currentEvent + 1;
    const started: number = entry.started_event ?? 1;
    const chips: ChipUse[] = (history.chips ?? []).map((c: any) => ({ name: chipFromFpl(c.name), event: c.event })).filter((c: any) => c.name);
    const fhEvents = new Set(chips.filter((c) => c.name === "freehit").map((c) => c.event));
    const transfers: RawTransfer[] = Array.isArray(transfersRaw) ? transfersRaw : [];
    const warnings: string[] = [];
    const derived: string[] = [];

    // Opening squad with prices
    const firstPicks = await getJson(`${BASE}/entry/${id}/event/${started}/picks/`);
    if (!firstPicks?.picks) throw new HttpError(404, "This team's picks are not available (the team may be private or the season has not started).");
    const initial = [];
    const replay = reconstructHoldings(firstPicks.picks.map((p: any) => ({ id: p.element, buyTenths: 0 })), transfers, fhEvents);
    const stillInitial = new Set(firstPicks.picks.map((p: any) => p.element).filter((e: number) => replay.some((h) => h.id === e)));
    for (const p of firstPicks.picks) {
      let price = 0;
      if (stillInitial.has(p.element)) {
        const sum = await getElementSummary(p.element);
        price = sum?.history?.find((h: any) => h.round === started)?.value ?? 0;
        if (!price) {
          price = ds.players.find((x) => x.id === p.element)?.costTenths ?? 0;
          warnings.push(`Opening price for player ${p.element} unavailable; current price used (selling price may be overstated).`);
        }
      }
      initial.push({ id: p.element, buyTenths: price });
    }
    derived.push("Purchase prices: opening squad from each player's GW" + started + " price, later buys from your transfer history.");
    const holdings = reconstructHoldings(initial, transfers, fhEvents);

    // Cross-check against the real picks of the current gameweek
    const currentPicks = currentEvent >= started ? await getJson(`${BASE}/entry/${id}/event/${currentEvent}/picks/`) : null;
    const pendingTransfers = transfers.filter((t) => t.event > currentEvent && !fhEvents.has(t.event));
    if (currentPicks?.picks && !fhEvents.has(currentEvent)) {
      const actualIds = new Set<number>(currentPicks.picks.map((p: any) => p.element));
      for (const t of pendingTransfers) {
        actualIds.delete(t.element_out);
        actualIds.add(t.element_in);
      }
      const mine = new Set(holdings.map((h) => h.id));
      if (actualIds.size !== mine.size || [...actualIds].some((x) => !mine.has(x))) {
        warnings.push("Rebuilt squad did not exactly match your FPL picks; using the FPL picks with current prices as purchase price.");
        holdings.length = 0;
        for (const pid of actualIds) holdings.push({ id: pid, buyTenths: ds.players.find((p) => p.id === pid)?.costTenths ?? 0 });
      }
    }

    // Bank: after the last finished gameweek (before any Free Hit), plus transfers already queued for the next one
    const rows: any[] = history.current ?? [];
    const bankRow = rows.find((r) => r.event === (fhEvents.has(currentEvent) ? currentEvent - 1 : currentEvent)) ?? rows[rows.length - 1];
    let bank = bankRow?.bank ?? 0;
    for (const t of pendingTransfers) bank += t.element_out_cost - t.element_in_cost;

    // Free transfers (derived)
    const byEvent: Record<number, number> = {};
    for (const r of rows) byEvent[r.event] = r.event_transfers ?? 0;
    const ftNext = simulateFreeTransfers(started, currentEvent, byEvent, chips, ds.rules);
    const queued = pendingTransfers.length;
    const freeTransfers = Math.max(0, ftNext - queued);
    derived.push(`Free transfers: derived by replaying your history under the 2026/27 rules (the API does not expose them)${queued ? `; ${queued} transfer(s) already queued for GW${nextEvent} were deducted` : ""}.`);

    const lastPicks = currentPicks?.picks ?? firstPicks.picks;
    const cap = lastPicks.find((p: any) => p.is_captain)?.element;
    const vice = lastPicks.find((p: any) => p.is_vice_captain)?.element;

    const state: SeasonState = {
      version: 1,
      source: "import",
      teamId: id,
      teamName: entry.name,
      actual: { gw: nextEvent, holdings, bankTenths: bank, freeTransfers, chipsUsed: chips, captain: cap, vice },
      plans: {},
      snapshots: [],
      recs: [],
      actualHistory: rows.map((r) => ({ event: r.event, points: r.points, transferCost: r.event_transfers_cost, totalPoints: r.total_points, value: r.value, bank: r.bank, chip: chips.find((c) => c.event === r.event)?.name ?? null })),
      warnings,
      updatedAt: new Date().toISOString(),
    };
    return NextResponse.json({
      state,
      entry: { id, name: entry.name, manager: `${entry.player_first_name} ${entry.player_last_name}`.trim(), overallRank: entry.summary_overall_rank ?? null, overallPoints: entry.summary_overall_points ?? null },
      transfers: transfers.slice(0, 50),
      derived,
      queuedTransfers: queued,
      available: { squad: true, teamValue: true, bank: true, freeTransfers: "derived", transferHistory: true, captain: !!currentPicks, chipHistory: true },
    });
  } catch (e) {
    return fail(e);
  }
}
