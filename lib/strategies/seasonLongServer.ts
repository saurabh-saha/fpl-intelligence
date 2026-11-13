import type { Dataset } from "../fpl/types";
import { HttpError } from "../api";
import type { NewsOverlay } from "../news/overlay";
import { buildSeasonHorizon, type SeasonHorizon } from "./seasonLong";

const cache = new Map<string, SeasonHorizon>();

/** Remaining-season horizon (GW..endGw), cached per dataset snapshot. */
export function getSeasonHorizon(ds: Dataset, gw: number, endGw?: number, news?: NewsOverlay | null): SeasonHorizon {
  const last = ds.events[ds.events.length - 1]?.id ?? gw;
  const end = endGw === undefined ? last : endGw;
  const key = `${ds.fetchedAt}:${ds.source}:${gw}:${end}:${news?.version ?? "no-news"}`;
  let hz = cache.get(key);
  if (!hz) {
    hz = buildSeasonHorizon(ds, gw, { endGw: end, news });
    cache.set(key, hz);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return hz;
}

/** horizonEnd must be an integer gameweek between the selected gameweek and the last gameweek. */
export function parseHorizonEnd(raw: unknown, ds: Dataset, gw: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  const last = ds.events[ds.events.length - 1]?.id ?? gw;
  if (!Number.isInteger(n) || n < gw || n > last) throw new HttpError(400, `horizonEnd must be a gameweek between GW${gw} and GW${last}.`);
  return n;
}
