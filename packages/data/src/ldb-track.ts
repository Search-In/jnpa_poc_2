/**
 * NLDS Logistics Data Bank (LDB) container track client.
 *
 * Mirrors the public LDB search used by https://ldb.co.in :
 *   GET /api/ldb/container/search?cntrNo={ISO-6346}&searchType=39  (Single)
 *
 * The web app proxies `/ldb` → LDB origin in dev so the browser stays same-origin.
 * Response shapes vary (`object` is either one ContainerSearchData or a ListN
 * array on "partial"); this module normalises both into {@link NldsContainerTrack}.
 */

/** One event row inside a location stop (PORT IN, CFS IN, DPD, …). */
export interface NldsTrackEvent {
  eventName: string;
  timestamp: string;
  timeZone?: string;
  transportMode?: string;
  truckNumber?: string;
  /** ldb | info | vessel — info rows render as status callouts. */
  dataType?: string;
  /** I / E / T / Laden … */
  type?: string;
  /** Stay duration at this location when LDB supplies avgLeadTime (ms). */
  durationMs?: number;
}

/** One vertical-timeline stop (location card) with its event rows. */
export interface NldsTrackStop {
  location: string;
  superOrg?: string;
  events: NldsTrackEvent[];
}

/** Normalised container track for the NLDS-style timeline UI. */
export interface NldsContainerTrack {
  containerNo: string;
  detail?: {
    size?: string;
    containerType?: string;
    isoCode?: string;
  };
  stops: NldsTrackStop[];
  /** True when LDB returned at least one track event. */
  found: boolean;
}

export interface FetchLdbTrackOptions {
  /** Base URL: relative `/ldb` (Vite proxy) or absolute `https://ldb.co.in`. */
  baseUrl?: string;
  /** LDB searchType — 39 = Single (default). */
  searchType?: string;
  fetchImpl?: typeof fetch;
}

interface LdbGroupingEvent {
  eventName?: string;
  timestampTimezone?: string;
  timeZoneAbvr?: string;
  transportMode?: string;
  truckNumber?: string;
  datatyp?: string;
  type?: string;
  superOrg?: string;
  currentLocation?: string;
  avgLeadTime?: number;
}

interface LdbTransitStop {
  currentLocation?: string;
  superOrg?: string;
  containerGroupingList?: LdbGroupingEvent[];
}

interface LdbTrackLogEvent {
  eventName?: string;
  currentLocation?: string;
  timestampTimezone?: string;
  timeZoneAbvr?: string;
  transportmode?: string;
  truck_number?: string;
  datatyp?: string;
  type?: string;
  superorg?: string;
  avgLeadTime?: number;
}

interface LdbSearchObject {
  result?: string;
  cntrDetail?: {
    size?: string;
    containerType?: string;
    isoCode?: string;
    cntrNumber?: string;
  };
  cntrInTransit?: LdbTransitStop[];
  trackLog?: LdbTrackLogEvent[];
}

interface LdbSearchResponse {
  message?: { text?: string };
  objectType?: string;
  object?: LdbSearchObject | LdbSearchObject[];
}

function pickSearchObject(raw: LdbSearchResponse): LdbSearchObject | undefined {
  const obj = raw.object;
  if (!obj) return undefined;
  if (Array.isArray(obj)) {
    // "partial" responses wrap one or more cycle payloads; prefer the richest.
    return obj
      .slice()
      .sort((a, b) => {
        const score = (o: LdbSearchObject) =>
          (o.cntrInTransit?.length ?? 0) * 10 + (o.trackLog?.length ?? 0);
        return score(b) - score(a);
      })[0];
  }
  return obj;
}

function fromTransit(stops: LdbTransitStop[]): NldsTrackStop[] {
  return stops
    .filter((s) => (s.containerGroupingList?.length ?? 0) > 0)
    .map((s) => ({
      location: s.currentLocation?.trim() || 'Unknown location',
      superOrg: s.superOrg?.trim() || undefined,
      events: (s.containerGroupingList ?? []).map((e) => ({
        eventName: e.eventName?.trim() || 'EVENT',
        timestamp: e.timestampTimezone ?? '',
        timeZone: e.timeZoneAbvr,
        transportMode: e.transportMode,
        truckNumber: e.truckNumber,
        dataType: e.datatyp,
        type: e.type,
      })),
    }));
}

function fromTrackLog(log: LdbTrackLogEvent[]): NldsTrackStop[] {
  // Collapse consecutive same-location events into one stop (NLDS card grouping).
  const stops: NldsTrackStop[] = [];
  for (const e of log) {
    const location = e.currentLocation?.trim() || 'Unknown location';
    const superOrg = e.superorg?.trim() || undefined;
    const event: NldsTrackEvent = {
      eventName: e.eventName?.trim() || 'EVENT',
      timestamp: e.timestampTimezone ?? '',
      timeZone: e.timeZoneAbvr,
      transportMode: e.transportmode,
      truckNumber: e.truck_number,
      dataType: e.datatyp,
      type: e.type,
      durationMs: typeof e.avgLeadTime === 'number' ? e.avgLeadTime : undefined,
    };
    const last = stops[stops.length - 1];
    if (last && last.location === location && last.superOrg === superOrg) {
      last.events.push(event);
    } else {
      stops.push({ location, superOrg, events: [event] });
    }
  }
  return stops;
}

/** Map a raw LDB JSON body into the UI DTO. */
export function normalizeLdbSearch(raw: LdbSearchResponse, containerNo: string): NldsContainerTrack {
  const obj = pickSearchObject(raw);
  if (!obj || obj.result === 'No Record Found') {
    return { containerNo, stops: [], found: false };
  }
  const transit = obj.cntrInTransit ?? [];
  const stops =
    transit.length > 0 ? fromTransit(transit) : fromTrackLog(obj.trackLog ?? []);
  return {
    containerNo: obj.cntrDetail?.cntrNumber?.trim() || containerNo,
    detail: obj.cntrDetail
      ? {
          size: obj.cntrDetail.size,
          containerType: obj.cntrDetail.containerType,
          isoCode: obj.cntrDetail.isoCode,
        }
      : undefined,
    stops,
    found: stops.length > 0,
  };
}

/**
 * Fetch NLDS/LDB inland-transit track for one container.
 * `searchType=39` is the Single-container search used by the public LDB UI.
 */
export async function fetchLdbContainerTrack(
  containerNo: string,
  opts: FetchLdbTrackOptions = {},
): Promise<NldsContainerTrack> {
  const norm = containerNo.trim().toUpperCase();
  if (!norm) {
    return { containerNo: '', stops: [], found: false };
  }
  const base = (opts.baseUrl ?? '/ldb').replace(/\/$/, '');
  const searchType = opts.searchType ?? '39';
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const qs = new URLSearchParams({ cntrNo: norm, searchType });
  const url = `${base}/api/ldb/container/search?${qs.toString()}`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) {
    throw new Error(`NLDS/LDB track failed (HTTP ${res.status}) for ${norm}.`);
  }
  const body = (await res.json()) as LdbSearchResponse;
  return normalizeLdbSearch(body, norm);
}

/** Format an LDB avgLeadTime (ms) like "4Days 13Hr. 45Min." */
export function formatLeadTime(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}Day${days === 1 ? '' : 's'}`);
  if (hours || days) parts.push(`${hours}Hr.`);
  parts.push(`${mins}Min.`);
  return parts.join(' ');
}
