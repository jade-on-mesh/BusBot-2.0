// Static GTFS for every agency in feeds.json, loaded side by side.
//
// Agencies reuse the same ids (Metro stop 1120 and Community Transit stop
// 1120 are different places), so everything internal is keyed as
// "<agency>:<id>". Riders keep typing plain stop numbers; resolveStop()
// works out which agency they mean.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FeedInfo } from "./types";
import { gtfsTimeToSeconds, ServiceDay } from "./time";

// ---------- feed config ----------

export type RtSource = { url: string; format: "json" | "pb" };
export type FeedConfig = {
	id: string;
	name: string;
	codes: string[];
	default?: boolean;
	url?: string;
	dir?: string; // defaults to data/<id>
	oba?: string;
	tripUpdates?: RtSource;
	alerts?: RtSource;
	credit?: string;
};

const FEEDS_FILE = process.env.FEEDS_FILE || "./feeds.json";

export const readFeedConfig = (): FeedConfig[] => {
	const feeds = (JSON.parse(readFileSync(FEEDS_FILE, "utf8")).feeds ?? []) as FeedConfig[];
	const only = (process.env.FEEDS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return feeds
		.filter((f) => !only.length || only.includes(f.id))
		.map((f) => {
			// Older .env files set Metro's realtime URLs here; keep honoring them.
			if (f.id === "kcm") {
				if (process.env.METRO_GTFS_RT_TRIP_UPDATES_FEED)
					f.tripUpdates = { url: process.env.METRO_GTFS_RT_TRIP_UPDATES_FEED, format: "json" };
				if (process.env.METRO_GTFS_RT_SERVICE_ALERTS_FEED)
					f.alerts = { url: process.env.METRO_GTFS_RT_SERVICE_ALERTS_FEED, format: "json" };
			}
			return f;
		});
};

// Where a feed's converted JSON lives. Metro data converted before the
// multi-agency layout (metro/json) is still picked up.
export const feedDir = (f: FeedConfig) => {
	const base = f.dir ? path.resolve(path.dirname(FEEDS_FILE), f.dir) : path.join("data", f.id);
	return base;
};
const jsonDir = (f: FeedConfig) => {
	const dir = path.join(feedDir(f), "json");
	if (!existsSync(dir) && f.id === "kcm" && existsSync("metro/json")) return "metro/json";
	return dir;
};

// ---------- types & indexes ----------

export type Stop = {
	key: string; // "<agency>:<stop_id>"
	agency: string;
	stop_id: string;
	stop_code?: string;
	stop_name: string;
	stop_lat?: string;
	stop_lon?: string;
};
export type Route = {
	key: string;
	agency: string;
	route_id: string;
	route_short_name: string;
	route_long_name?: string;
	route_type?: string;
};
export type Trip = {
	key: string;
	agency: string;
	trip_id: string;
	route_key: string;
	service_key: string;
	trip_headsign?: string;
};
export type StopTime = { trip_key: string; arrivalSec: number; stop_sequence: number };

export const feeds = new Map<string, FeedConfig>(); // loaded feeds only
export const feedInfos = new Map<string, FeedInfo>();
export const stopsByKey = new Map<string, Stop>();
export const routesByKey = new Map<string, Route>();
export const tripsByKey = new Map<string, Trip>();
export const stopTimesByStop = new Map<string, StopTime[]>();
export const routesByStop = new Map<string, Set<string>>(); // stop key -> route keys
const stopsByTyped = new Map<string, Stop[]>(); // stop_id / stop_code as typed -> stops
const routesByName = new Map<string, Route[]>();
const calendarByKey = new Map<string, Record<string, string>>();
const calendarDates = new Map<string, Map<string, string>>(); // service key -> date -> exception_type
const codeToAgency = new Map<string, string>();
export let defaultAgency = "kcm";

// Old conversions kept literal quotes ("\"G Line\""); strip them.
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/^"(.*)"$/, "$1").trim() : v);

const loadTable = (dir: string, name: string, required = true): Record<string, string>[] => {
	const file = path.join(dir, `${name}.json`);
	if (!existsSync(file)) {
		if (required) throw new Error(`Missing ${file}`);
		return [];
	}
	const rows = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>[];
	for (const row of rows) for (const k of Object.keys(row)) row[k] = clean(row[k]) as string;
	return rows;
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
};

const loadFeed = (f: FeedConfig) => {
	const dir = jsonDir(f);
	const a = f.id;
	const k = (id: string) => `${a}:${id}`;

	for (const s of loadTable(dir, "stops")) {
		const stop: Stop = {
			key: k(s.stop_id),
			agency: a,
			stop_id: s.stop_id,
			stop_code: s.stop_code || undefined,
			stop_name: s.stop_name,
			stop_lat: s.stop_lat,
			stop_lon: s.stop_lon,
		};
		stopsByKey.set(stop.key, stop);
		push(stopsByTyped, s.stop_id.toLowerCase(), stop);
		// Let riders use the number printed on the sign when it differs.
		if (s.stop_code && s.stop_code !== s.stop_id) push(stopsByTyped, s.stop_code.toLowerCase(), stop);
	}
	for (const r of loadTable(dir, "routes")) {
		const route: Route = {
			key: k(r.route_id),
			agency: a,
			route_id: r.route_id,
			route_short_name: r.route_short_name,
			route_long_name: r.route_long_name,
			route_type: r.route_type,
		};
		routesByKey.set(route.key, route);
		for (const name of [r.route_short_name, r.route_long_name]) {
			if (name) push(routesByName, name.toLowerCase(), route);
		}
	}
	for (const t of loadTable(dir, "trips")) {
		tripsByKey.set(k(t.trip_id), {
			key: k(t.trip_id),
			agency: a,
			trip_id: t.trip_id,
			route_key: k(t.route_id),
			service_key: k(t.service_id),
			trip_headsign: t.trip_headsign,
		});
	}
	for (const c of loadTable(dir, "calendar", false)) calendarByKey.set(k(c.service_id), c);
	for (const cd of loadTable(dir, "calendar_dates", false)) {
		const sk = k(cd.service_id);
		if (!calendarDates.has(sk)) calendarDates.set(sk, new Map());
		calendarDates.get(sk)!.set(cd.date, cd.exception_type);
	}
	for (const st of loadTable(dir, "stop_times")) {
		const time = st.arrival_time || st.departure_time;
		if (!time) continue; // untimed stops
		const stopKey = k(st.stop_id);
		const tripKey = k(st.trip_id);
		push(stopTimesByStop, stopKey, {
			trip_key: tripKey,
			arrivalSec: gtfsTimeToSeconds(time),
			stop_sequence: parseInt(st.stop_sequence),
		});
		const trip = tripsByKey.get(tripKey);
		if (trip) {
			const set = routesByStop.get(stopKey) ?? new Set();
			set.add(trip.route_key);
			routesByStop.set(stopKey, set);
		}
	}
	const info = loadTable(dir, "feed_info", false)[0] as unknown as FeedInfo | undefined;
	if (info) feedInfos.set(a, info);
	feeds.set(a, f);
	for (const code of [a, ...f.codes]) codeToAgency.set(code.toLowerCase(), a);
};

export const loadGtfs = () => {
	const config = readFeedConfig();
	defaultAgency = config.find((f) => f.default)?.id ?? config[0]?.id ?? "kcm";
	for (const f of config) {
		if (!existsSync(path.join(jsonDir(f), "stops.json"))) {
			console.log(`Skipping ${f.name}: no data yet (run "npm run feeds")`);
			continue;
		}
		const before = stopsByKey.size;
		loadFeed(f);
		console.log(`Loaded ${f.name}: ${stopsByKey.size - before} stops`);
	}
	for (const list of stopTimesByStop.values()) list.sort((a, b) => a.arrivalSec - b.arrivalSec);
	if (!feeds.size) throw new Error('No transit data loaded. Run "npm run feeds" first.');
	if (!feeds.has(defaultAgency)) defaultAgency = [...feeds.keys()][0];
	console.log(
		`GTFS loaded: ${feeds.size} agencies, ${stopsByKey.size} stops, ${routesByKey.size} routes, ${tripsByKey.size} trips`,
	);
};

// ---------- lookups ----------

export const agencyFromCode = (code: string) => codeToAgency.get(code.trim().toLowerCase());
export const agencyCode = (agency: string) => feeds.get(agency)?.codes[0] ?? agency;
export const agencyName = (agency: string) => feeds.get(agency)?.name ?? agency;

// How a rider would type this stop: "1120" for the default agency, else "ct 1120".
// What a rider types for this stop: the number on its sign (stop_code), or
// the feed's id when the agency doesn't publish sign numbers.
export const stopRef = (stop: Stop) => {
	const n = stop.stop_code || stop.stop_id;
	return stop.agency === defaultAgency ? n : `${agencyCode(stop.agency)} ${n}`;
};

export const findStops = (typed: string, agency?: string): Stop[] => {
	const all = stopsByTyped.get(typed.trim().toLowerCase()) ?? [];
	const t = typed.trim().toLowerCase();
	let unique = [...new Map(all.map((s) => [s.key, s])).values()];
	// The number on the sign wins: where an agency has a stop with that sign
	// number, its stops that only match by internal id ("pt 77", whose id is
	// 1120) aren't what the rider means.
	const bySign = new Set(unique.filter((s) => s.stop_code?.toLowerCase() === t).map((s) => s.agency));
	unique = unique.filter((s) => !bySign.has(s.agency) || s.stop_code?.toLowerCase() === t);
	return agency ? unique.filter((s) => s.agency === agency) : unique;
};

export type Place = { lat: number; lon: number };

export const metersBetween = (lat1: number, lon1: number, lat2: number, lon2: number) => {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLon = (lon2 - lon1) * rad;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
	return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
};

export const stopDistance = (stop: Stop, at: Place) =>
	stop.stop_lat && stop.stop_lon
		? metersBetween(at.lat, at.lon, parseFloat(stop.stop_lat), parseFloat(stop.stop_lon))
		: Infinity;

// Turns what a rider typed into one stop. When several agencies share the
// number, pick the one nearest the rider; without a location, the default
// agency (Metro); otherwise the first match. `others` lists the rest so the
// reply can say how to reach them.
export const resolveStop = (typed: string, opts: { agency?: string; near?: Place } = {}) => {
	const candidates = findStops(typed, opts.agency);
	if (!candidates.length) return undefined;
	let chosen = candidates[0];
	if (candidates.length > 1) {
		if (opts.near) {
			chosen = [...candidates].sort((a, b) => stopDistance(a, opts.near!) - stopDistance(b, opts.near!))[0];
		} else {
			chosen = candidates.find((s) => s.agency === defaultAgency) ?? candidates[0];
		}
	}
	return { stop: chosen, others: candidates.filter((s) => s.key !== chosen.key) };
};

// Stored references (favorites): "ct:1120", or a bare "1120" from before
// multi-agency support, which means the default agency.
export const stopFromKey = (key: string) =>
	stopsByKey.get(key.includes(":") ? key : `${defaultAgency}:${key}`);

// Route by short name ("11", "g line") or long name, within the stop's agency;
// prefer a route that actually serves the stop.
export const findRoute = (name: string, stop: Stop): Route | undefined => {
	const matches = (routesByName.get(name.trim().toLowerCase()) ?? []).filter((r) => r.agency === stop.agency);
	if (!matches.length) return undefined;
	const served = routesByStop.get(stop.key);
	return matches.find((r) => served?.has(r.key)) ?? matches[0];
};

// Honors calendar.txt date ranges and calendar_dates.txt exceptions.
export const isServiceActive = (serviceKey: string, day: ServiceDay): boolean => {
	const exception = calendarDates.get(serviceKey)?.get(day.date);
	if (exception === "1") return true;
	if (exception === "2") return false;
	const cal = calendarByKey.get(serviceKey);
	if (!cal) return false;
	if (cal.start_date && day.date < cal.start_date) return false;
	if (cal.end_date && day.date > cal.end_date) return false;
	return cal[day.weekday] === "1";
};

export const shortName = (route?: Route) => route?.route_short_name || route?.route_long_name || "?";

// Earliest-expiring feed, for the operator warning.
export const soonestFeedEnd = () => {
	let soonest: { agency: string; end: string } | undefined;
	for (const [agency, info] of feedInfos) {
		if (info.feed_end_date && (!soonest || info.feed_end_date < soonest.end)) {
			soonest = { agency, end: info.feed_end_date };
		}
	}
	return soonest;
};

// "ct 1120 201" -> { agency: "ct", stop: "1120", rest: ["201"] }; a leading
// agency code is optional.
export const parseStopArgs = (args: string[]) => {
	const agency = args.length >= 2 ? agencyFromCode(args[0]) : undefined;
	const [stop, ...rest] = agency ? args.slice(1) : args;
	return { agency, stop, rest };
};
