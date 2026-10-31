// Live data, per agency:
//  1. OneBusAway Puget Sound arrivals, when OBA_API_KEY is set (all agencies).
//  2. Each feed's own GTFS-realtime trip updates and alerts (JSON or protobuf),
//     from feeds.json, or OneBusAway's per-agency GTFS-RT when a key is set.
//  3. Nothing: the schedule alone, marked 🕒 in replies.
// Responses are cached briefly so a burst of mesh queries doesn't hammer anyone.
//
// Outage mode: every live source has a health record. When a fetch fails the
// source is skipped for a minute (so riders don't each wait out a timeout),
// the last good data keeps being used for up to 5 minutes (delays from a few
// minutes ago beat a bare schedule), and after that callers get status
// "down" so replies can say they're running on the schedule alone.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { FeedConfig, feeds, Stop } from "./gtfs";

const FETCH_TIMEOUT_MS = 10_000;
const redact = (url: string) => url.replace(/key=[^&]+/, "key=***");

// ---------- source health (outage mode) ----------

export type LiveStatus = "live" | "stale" | "down" | "none";
export type SourceHealth = { lastOk: number; lastFail: number; lastError?: string; skipUntil: number };

const SKIP_AFTER_FAIL_MS = 60_000;
const STALE_OK_MS = 5 * 60_000;

// source name ("kcm:tripUpdates", "oba") -> health
export const sourceHealth = new Map<string, SourceHealth>();
const healthOf = (name: string) => {
	let h = sourceHealth.get(name);
	if (!h) sourceHealth.set(name, (h = { lastOk: 0, lastFail: 0, skipUntil: 0 }));
	return h;
};

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
// Forget cached live data and source health (used by tests).
export const clearRealtimeCache = () => {
	allCaches.forEach((c) => c.clear());
	sourceHealth.clear();
};

type LiveResult<T> = { value?: T; status: Exclude<LiveStatus, "none"> };

// Fetches through a cache with outage handling. `source` names the upstream
// for health and skipping; `key` is what's being fetched from it.
const liveCache = <T>(ttlMs: number, source: (key: string) => string, loader: (key: string) => Promise<T>) => {
	const cache = new Map<string, { at: number; value: T }>();
	allCaches.push(cache);
	const inflight = new Map<string, Promise<LiveResult<T>>>();
	return async (key: string): Promise<LiveResult<T>> => {
		const now = Date.now();
		const hit = cache.get(key);
		if (hit && now - hit.at < ttlMs) return { value: hit.value, status: "live" };
		const name = source(key);
		const health = healthOf(name);
		const fallback = (): LiveResult<T> =>
			hit && now - hit.at < STALE_OK_MS ? { value: hit.value, status: "stale" } : { status: "down" };
		if (now < health.skipUntil) return fallback();

		let p = inflight.get(key);
		if (!p) {
			p = loader(key)
				.then((value): LiveResult<T> => {
					cache.set(key, { at: Date.now(), value });
					health.lastOk = Date.now();
					health.lastError = undefined;
					return { value, status: "live" };
				})
				.catch((e): LiveResult<T> => {
					health.lastFail = Date.now();
					health.lastError = (e as Error).message;
					health.skipUntil = Date.now() + SKIP_AFTER_FAIL_MS;
					console.log(`Live data unavailable from ${name}: ${health.lastError}`);
					return fallback();
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

const tripUpdatesCached = liveCache(
	30_000,
	(agency) => `${agency}:tripUpdates`,
	async (agency: string) => {
		const src = sourceFor(feeds.get(agency)!, "tripUpdates")!;
		const data = await fetchFeed(src.url, src.format);
		const map = new Map<string, TripUpdate>();
		for (const e of data?.entity ?? []) {
			const tu: TripUpdate | undefined = e.trip_update;
			if (tu?.trip?.trip_id) map.set(tu.trip.trip_id, tu);
		}
		return map;
	},
);

// trip_id -> update for one agency, plus whether it's live, slightly stale,
// unreachable, or the agency has no live feed at all.
export const getTripUpdates = async (agency: string): Promise<{ updates: Map<string, TripUpdate>; status: LiveStatus }> => {
	const f = feeds.get(agency);
	if (!f || !sourceFor(f, "tripUpdates")) return { updates: new Map(), status: "none" };
	const { value, status } = await tripUpdatesCached(agency);
	return { updates: value ?? new Map(), status };
};

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

const alertsCached = liveCache(
	60_000,
	(agency) => `${agency}:alerts`,
	async (agency: string): Promise<Alert[]> => {
		const src = sourceFor(feeds.get(agency)!, "alerts")!;
		const data = await fetchFeed(src.url, src.format);
		return (data?.entity ?? []).filter((e: any) => e?.alert).map((e: any) => ({ ...e, agency }));
	},
);

export const getAlertsFor = async (agency: string): Promise<{ alerts: Alert[]; status: LiveStatus }> => {
	const f = feeds.get(agency);
	if (!f || !sourceFor(f, "alerts")) return { alerts: [], status: "none" };
	const { value, status } = await alertsCached(agency);
	return { alerts: value ?? [], status };
};

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

const obaArrivalsCached = liveCache(30_000, () => "oba", async (obaStopId: string) => {
	const url = `${obaBase()}/api/where/arrivals-and-departures-for-stop/${encodeURIComponent(
		obaStopId,
	)}.json?key=${obaKey()}&minutesBefore=2&minutesAfter=120`;
	const data = await fetchJson(url);
	if (data?.code !== 200 || !data?.data?.entry) {
		throw new Error(`OneBusAway returned code ${data?.code}: ${data?.text ?? "no entry"}`);
	}
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

// Arrivals and alerts for a stop from OneBusAway. Throws when OneBusAway
// isn't set up for the agency or can't be reached (and has nothing recent),
// so callers fall back to the agency's own feed and the schedule.
export const getObaArrivals = async (stop: Stop) => {
	const oba = feeds.get(stop.agency)?.oba;
	if (!oba) throw new Error(`no OneBusAway agency id for ${stop.agency}`);
	const { value } = await obaArrivalsCached(`${oba}_${stop.stop_id}`);
	if (!value) throw new Error("OneBusAway unavailable");
	return value;
};

export const obaCovers = (stop: Stop) => obaEnabled() && Boolean(feeds.get(stop.agency)?.oba);

// For /health: each live source's state.
export const liveSummary = () =>
	Object.fromEntries(
		[...sourceHealth.entries()].map(([name, h]) => [
			name,
			{
				ok: h.lastOk >= h.lastFail,
				lastOk: h.lastOk ? new Date(h.lastOk).toISOString() : null,
				lastError: h.lastOk >= h.lastFail ? undefined : h.lastError,
			},
		]),
	);
