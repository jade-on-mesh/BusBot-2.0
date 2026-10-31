// Real-time data sources:
//  1. OneBusAway (Puget Sound) when OBA_API_KEY is set  — issue #1
//  2. King County Metro GTFS-RT JSON feeds (trip updates + alerts)
// Responses are cached briefly so a burst of mesh queries doesn't hammer the APIs.

const FETCH_TIMEOUT_MS = 10_000;

const fetchJson = async (url: string): Promise<any> => {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.replace(/key=[^&]+/, "key=***")}`);
	return res.json();
};

const cached = <T>(ttlMs: number, loader: () => Promise<T>) => {
	let value: T | undefined;
	let fetchedAt = 0;
	let inflight: Promise<T> | undefined;
	return async (): Promise<T> => {
		if (value !== undefined && Date.now() - fetchedAt < ttlMs) return value;
		if (!inflight) {
			inflight = loader()
				.then((v) => {
					value = v;
					fetchedAt = Date.now();
					return v;
				})
				.finally(() => (inflight = undefined));
		}
		return inflight;
	};
};

// ---------- GTFS-RT ----------

export type StopTimeUpdate = {
	stop_sequence?: number;
	stop_id?: string;
	arrival?: { delay?: number; time?: number };
	departure?: { delay?: number; time?: number };
	schedule_relationship?: string;
};
export type TripUpdate = {
	trip: { trip_id: string; route_id?: string; schedule_relationship?: string };
	stop_time_update?: StopTimeUpdate[];
};

export const getTripUpdates = cached(30_000, async () => {
	const map = new Map<string, TripUpdate>();
	const url = process.env.METRO_GTFS_RT_TRIP_UPDATES_FEED;
	if (!url) return map;
	try {
		const data = await fetchJson(url);
		for (const e of data?.entity ?? []) {
			const tu: TripUpdate | undefined = e.trip_update ?? e.tripUpdate;
			const id = tu?.trip?.trip_id ?? (tu?.trip as any)?.tripId;
			if (tu && id) map.set(id, tu);
		}
	} catch (e) {
		console.log("Error getting realtime trip updates:", (e as Error).message);
	}
	return map;
});

type Translation = { text: string; language?: string };
type TranslatedString = { translation?: Translation[] };
export type Alert = {
	id: string;
	alert: {
		header_text?: TranslatedString;
		short_header_text?: TranslatedString;
		description_text?: TranslatedString;
		active_period?: { start?: number; end?: number }[];
		informed_entity?: { agency_id?: string; route_id?: string; stop_id?: string; trip?: any }[];
	};
};

export const getAlerts = cached(60_000, async (): Promise<Alert[]> => {
	const url = process.env.METRO_GTFS_RT_SERVICE_ALERTS_FEED;
	if (!url) return [];
	try {
		const data = await fetchJson(url);
		return (data?.entity ?? []).filter((e: any) => e?.alert);
	} catch (e) {
		console.log("Error getting alerts:", (e as Error).message);
		return [];
	}
});

// Picks the translation for LANGUAGE_CODE, falling back to the first one.
// Fixes the original `index ? index : 0` bug, where -1 (not found) is truthy
// and crashed the command.
export const translate = (s?: TranslatedString): string | undefined => {
	const list = s?.translation ?? [];
	const lang = (process.env.LANGUAGE_CODE || "en").toLowerCase();
	return (
		list.find((t) => t.language?.toLowerCase() === lang) ??
		list.find((t) => t.language?.toLowerCase().startsWith(lang.split("-")[0])) ??
		list[0]
	)?.text;
};

// ---------- OneBusAway ----------

export type ObaArrival = {
	routeShortName: string;
	routeId: string;
	tripHeadsign?: string;
	epochMs: number;
	realtime: boolean;
};

export const obaEnabled = () => Boolean(process.env.OBA_API_KEY);

const obaBase = () =>
	(process.env.OBA_API_URL || "https://api.pugetsound.onebusaway.org").replace(/\/$/, "");

// GTFS stop ids are prefixed with the OBA agency id ("1_" for King County Metro).
const obaStopId = (stopId: string) =>
	stopId.includes("_") ? stopId : `${process.env.OBA_AGENCY_ID || "1"}_${stopId}`;

const obaCache = new Map<string, { at: number; value: { arrivals: ObaArrival[]; alerts: string[] } }>();

export const getObaArrivals = async (stopId: string) => {
	const id = obaStopId(stopId);
	const hit = obaCache.get(id);
	if (hit && Date.now() - hit.at < 30_000) return hit.value;

	const url = `${obaBase()}/api/where/arrivals-and-departures-for-stop/${encodeURIComponent(
		id,
	)}.json?key=${encodeURIComponent(process.env.OBA_API_KEY!)}&minutesBefore=2&minutesAfter=120`;
	const data = await fetchJson(url);
	if (data?.code !== 200 || !data?.data?.entry) {
		throw new Error(`OneBusAway returned code ${data?.code}: ${data?.text ?? "no entry"}`);
	}
	const arrivals: ObaArrival[] = (data.data.entry.arrivalsAndDepartures ?? []).map((a: any) => {
		const predicted = Boolean(a.predicted) && a.predictedArrivalTime > 0;
		return {
			routeShortName: a.routeShortName || a.routeLongName || a.routeId,
			routeId: String(a.routeId ?? "").replace(/^\d+_/, ""),
			tripHeadsign: a.tripHeadsign,
			epochMs: predicted ? a.predictedArrivalTime : a.scheduledArrivalTime,
			realtime: predicted,
		};
	});
	const alerts: string[] = (data.data.references?.situations ?? [])
		.map((s: any) => s.summary?.value || s.description?.value)
		.filter(Boolean);
	const value = { arrivals, alerts };
	obaCache.set(id, { at: Date.now(), value });
	if (obaCache.size > 500) obaCache.delete(obaCache.keys().next().value!);
	return value;
};
