// Live data, per agency:
//  1. OneBusAway Puget Sound arrivals, when OBA_API_KEY is set (all agencies).
//  2. Each feed's own GTFS-realtime trip updates and alerts (JSON or protobuf),
//     from feeds.json, or OneBusAway's per-agency GTFS-RT when a key is set.
//  3. Nothing: the schedule alone, marked 🕒 in replies.
// Responses are cached briefly so a burst of mesh queries doesn't hammer anyone.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { FeedConfig, feeds, Stop } from "./gtfs";

const FETCH_TIMEOUT_MS = 10_000;
const redact = (url: string) => url.replace(/key=[^&]+/, "key=***");

// ---------- realtime health (for outage awareness) ----------

// Last time any live source answered, and whether the latest attempt failed.
export const liveHealth = { lastOk: 0, lastFail: 0 };
const ok = () => (liveHealth.lastOk = Date.now());
const fail = () => (liveHealth.lastFail = Date.now());

// ---------- fetching & decoding ----------

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
// protobuf decodes to camelCase (tripUpdate); KCM's JSON is snake_case
// (trip_update). Normalize everything to snake_case.
const snakeKeys = (v: any): any => {
	if (Array.isArray(v)) return v.map(snakeKeys);
	if (v && typeof v === "object") {
		const out: any = {};
		for (const [k, val] of Object.entries(v)) out[snake(k)] = snakeKeys(val);
		return out;
	}
	return v;
};

const fetchFeed = async (url: string, format: "json" | "pb"): Promise<any> => {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
	if (format === "json") return snakeKeys(await res.json());
	const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
	const msg = FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
	return snakeKeys(FeedMessage.toObject(msg, { enums: String, longs: Number, defaults: false }));
};

const fetchJson = async (url: string): Promise<any> => {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
	return res.json();
};

const allCaches: Map<string, unknown>[] = [];
// Forget cached live data (used by tests; config doesn't change at runtime).
export const clearRealtimeCache = () => allCaches.forEach((c) => c.clear());

const cachedBy = <T>(ttlMs: number, loader: (key: string) => Promise<T>) => {
	const cache = new Map<string, { at: number; value: T }>();
	allCaches.push(cache);
	const inflight = new Map<string, Promise<T>>();
	return async (key: string): Promise<T> => {
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < ttlMs) return hit.value;
		let p = inflight.get(key);
		if (!p) {
			p = loader(key)
				.then((value) => {
					cache.set(key, { at: Date.now(), value });
					return value;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, p);
		}
		return p;
	};
};

// ---------- OneBusAway ----------

export const obaEnabled = () => Boolean(process.env.OBA_API_KEY);
const obaBase = () => (process.env.OBA_API_URL || "https://api.pugetsound.onebusaway.org").replace(/\/$/, "");
const obaKey = () => encodeURIComponent(process.env.OBA_API_KEY ?? "");

// A feed's realtime sources: its own, or OneBusAway's GTFS-RT for its agency.
const sourceFor = (f: FeedConfig, kind: "tripUpdates" | "alerts") => {
	if (f[kind]) return f[kind];
	if (obaEnabled() && f.oba) {
		const path = kind === "tripUpdates" ? "trip-updates-for-agency" : "alerts-for-agency";
		return { url: `${obaBase()}/api/gtfs_realtime/${path}/${f.oba}.pb?key=${obaKey()}`, format: "pb" as const };
	}
	return undefined;
};

// ---------- trip updates ----------

export type StopTimeUpdate = {
	stop_sequence?: number;
	stop_id?: string;
	arrival?: { delay?: number; time?: number };
	departure?: { delay?: number; time?: number };
	schedule_relationship?: string;
};
export type TripUpdate = {
	trip: { trip_id: string; route_id?: string; start_date?: string; schedule_relationship?: string };
	stop_time_update?: StopTimeUpdate[];
};

// trip_id -> update, for one agency
export const getTripUpdates = cachedBy(30_000, async (agency: string) => {
	const map = new Map<string, TripUpdate>();
	const f = feeds.get(agency);
	const src = f && sourceFor(f, "tripUpdates");
	if (!src) return map;
	try {
		const data = await fetchFeed(src.url, src.format);
		for (const e of data?.entity ?? []) {
			const tu: TripUpdate | undefined = e.trip_update;
			if (tu?.trip?.trip_id) map.set(tu.trip.trip_id, tu);
		}
		ok();
	} catch (e) {
		fail();
		console.log(`Realtime trip updates failed for ${agency}:`, (e as Error).message);
	}
	return map;
});

// ---------- alerts ----------

type Translation = { text: string; language?: string };
type TranslatedString = { translation?: Translation[] };
export type Alert = {
	id: string;
	agency: string;
	alert: {
		header_text?: TranslatedString;
		short_header_text?: TranslatedString;
		description_text?: TranslatedString;
		active_period?: { start?: number; end?: number }[];
		informed_entity?: { agency_id?: string; route_id?: string; stop_id?: string; trip?: any }[];
	};
};

export const getAlertsFor = cachedBy(60_000, async (agency: string): Promise<Alert[]> => {
	const f = feeds.get(agency);
	const src = f && sourceFor(f, "alerts");
	if (!src) return [];
	try {
		const data = await fetchFeed(src.url, src.format);
		ok();
		return (data?.entity ?? []).filter((e: any) => e?.alert).map((e: any) => ({ ...e, agency }));
	} catch (e) {
		fail();
		console.log(`Alerts failed for ${agency}:`, (e as Error).message);
		return [];
	}
});

// Picks the translation for LANGUAGE_CODE, falling back to the first one.
export const translate = (s?: TranslatedString): string | undefined => {
	const list = s?.translation ?? [];
	const lang = (process.env.LANGUAGE_CODE || "en").toLowerCase();
	return (
		list.find((t) => t.language?.toLowerCase() === lang) ??
		list.find((t) => t.language?.toLowerCase().startsWith(lang.split("-")[0])) ??
		list[0]
	)?.text;
};

// ---------- OneBusAway arrivals ----------

export type ObaArrival = {
	routeShortName: string;
	routeKey?: string; // "<agency>:<route_id>" when the route's agency is loaded
	tripHeadsign?: string;
	epochMs: number;
	realtime: boolean;
};

// OBA ids look like "40_100236": agency 40, route 100236.
const fromObaId = (obaId: string) => {
	const m = /^([^_]+)_(.+)$/.exec(obaId ?? "");
	if (!m) return undefined;
	const feed = [...feeds.values()].find((f) => f.oba === m[1]);
	return feed ? `${feed.id}:${m[2]}` : undefined;
};

const obaArrivalsCached = cachedBy(30_000, async (obaStopId: string) => {
	const url = `${obaBase()}/api/where/arrivals-and-departures-for-stop/${encodeURIComponent(
		obaStopId,
	)}.json?key=${obaKey()}&minutesBefore=2&minutesAfter=120`;
	let data: any;
	try {
		data = await fetchJson(url);
	} catch (e) {
		fail();
		throw e;
	}
	if (data?.code !== 200 || !data?.data?.entry) {
		fail();
		throw new Error(`OneBusAway returned code ${data?.code}: ${data?.text ?? "no entry"}`);
	}
	ok();
	const arrivals: ObaArrival[] = (data.data.entry.arrivalsAndDepartures ?? []).map((a: any) => {
		const predicted = Boolean(a.predicted) && a.predictedArrivalTime > 0;
		return {
			routeShortName: a.routeShortName || a.routeLongName || a.routeId,
			routeKey: fromObaId(a.routeId),
			tripHeadsign: a.tripHeadsign,
			epochMs: predicted ? a.predictedArrivalTime : a.scheduledArrivalTime,
			realtime: predicted,
		};
	});
	const alerts: string[] = (data.data.references?.situations ?? [])
		.map((s: any) => s.summary?.value || s.description?.value)
		.filter(Boolean);
	return { arrivals, alerts };
});

export const getObaArrivals = async (stop: Stop) => {
	const oba = feeds.get(stop.agency)?.oba;
	if (!oba) throw new Error(`no OneBusAway agency id for ${stop.agency}`);
	return obaArrivalsCached(`${oba}_${stop.stop_id}`);
};
