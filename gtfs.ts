// Static GTFS data, loaded once and indexed so each query is a map lookup
// instead of scanning millions of stop_times rows.
import { existsSync, readFileSync } from "node:fs";
import { FeedInfo } from "./types";
import { gtfsTimeToSeconds, ServiceDay } from "./time";

const DATA_DIR = process.env.GTFS_JSON_DIR || "./metro/json";

// Data converted by the old script kept literal quotes ("\"G Line\"").
// Strip them so both old and new conversions work.
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/^"(.*)"$/, "$1").trim() : v);

const load = (name: string, required = true): Record<string, string>[] => {
	const file = `${DATA_DIR}/${name}.json`;
	if (!existsSync(file)) {
		if (required) throw new Error(`Missing ${file}. Run "npm run setup" after extracting GTFS.`);
		return [];
	}
	const rows = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>[];
	for (const row of rows) for (const k of Object.keys(row)) row[k] = clean(row[k]) as string;
	return rows;
};

export type Stop = {
	stop_id: string;
	stop_code?: string;
	stop_name: string;
	stop_lat?: string;
	stop_lon?: string;
};
export type Route = {
	route_id: string;
	route_short_name: string;
	route_long_name?: string;
	route_type?: string;
};
export type Trip = { trip_id: string; route_id: string; service_id: string; trip_headsign?: string };
export type StopTime = { trip_id: string; arrivalSec: number; stop_sequence: number };

export const stopsById = new Map<string, Stop>();
export const routesById = new Map<string, Route>();
const routesByName = new Map<string, Route[]>();
export const tripsById = new Map<string, Trip>();
export const stopTimesByStop = new Map<string, StopTime[]>();
export const routesByStop = new Map<string, Set<string>>();
const calendarById = new Map<string, Record<string, string>>();
const calendarDates = new Map<string, Map<string, string>>(); // service_id -> date -> exception_type
export let feedInfo: FeedInfo | undefined;

export const loadGtfs = () => {
	for (const s of load("stops")) {
		stopsById.set(s.stop_id, s as Stop);
		// Allow riders to use the stop code printed on the sign, if it differs.
		if (s.stop_code && s.stop_code !== s.stop_id && !stopsById.has(s.stop_code)) {
			stopsById.set(s.stop_code, s as Stop);
		}
	}
	for (const r of load("routes")) {
		routesById.set(r.route_id, r as Route);
		for (const name of [r.route_short_name, r.route_long_name]) {
			if (!name) continue;
			const key = name.toLowerCase();
			routesByName.set(key, [...(routesByName.get(key) ?? []), r as Route]);
		}
	}
	for (const t of load("trips")) tripsById.set(t.trip_id, t as Trip);
	for (const c of load("calendar", false)) calendarById.set(c.service_id, c);
	for (const cd of load("calendar_dates", false)) {
		if (!calendarDates.has(cd.service_id)) calendarDates.set(cd.service_id, new Map());
		calendarDates.get(cd.service_id)!.set(cd.date, cd.exception_type);
	}

	for (const st of load("stop_times")) {
		const time = st.arrival_time || st.departure_time;
		if (!time) continue; // untimed stops
		const list = stopTimesByStop.get(st.stop_id) ?? [];
		list.push({
			trip_id: st.trip_id,
			arrivalSec: gtfsTimeToSeconds(time),
			stop_sequence: parseInt(st.stop_sequence),
		});
		stopTimesByStop.set(st.stop_id, list);
		const trip = tripsById.get(st.trip_id);
		if (trip) {
			const set = routesByStop.get(st.stop_id) ?? new Set();
			set.add(trip.route_id);
			routesByStop.set(st.stop_id, set);
		}
	}
	for (const list of stopTimesByStop.values()) list.sort((a, b) => a.arrivalSec - b.arrivalSec);

	feedInfo = load("feed_info", false)[0] as unknown as FeedInfo | undefined;
	console.log(
		`GTFS loaded: ${stopsById.size} stops, ${routesById.size} routes, ${tripsById.size} trips`,
	);
};

export const findStop = (id: string) => stopsById.get(id.trim());

// Route lookup by short name ("11", "g line") or long name ("first hill streetcar").
// If several agencies share a short name, prefer one that serves the given stop.
export const findRoute = (name: string, stopId?: string): Route | undefined => {
	const matches = routesByName.get(name.trim().toLowerCase());
	if (!matches?.length) return undefined;
	if (stopId) {
		const served = routesByStop.get(stopId);
		const hit = matches.find((r) => served?.has(r.route_id));
		if (hit) return hit;
	}
	return matches[0];
};

// Honors calendar.txt date ranges and calendar_dates.txt exceptions
// (holidays, special service). The original code only checked weekday and
// crashed on service_ids defined only in calendar_dates.
export const isServiceActive = (serviceId: string, day: ServiceDay): boolean => {
	const exception = calendarDates.get(serviceId)?.get(day.date);
	if (exception === "1") return true;
	if (exception === "2") return false;
	const cal = calendarById.get(serviceId);
	if (!cal) return false;
	if (cal.start_date && day.date < cal.start_date) return false;
	if (cal.end_date && day.date > cal.end_date) return false;
	return cal[day.weekday] === "1";
};

export const shortName = (route?: Route) => route?.route_short_name || route?.route_long_name || "?";
