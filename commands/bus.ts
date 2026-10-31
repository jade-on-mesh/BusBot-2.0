import {
	agencyCode,
	defaultAgency,
	findRoute,
	isServiceActive,
	Place,
	resolveStop,
	Route,
	routesByKey,
	shortName,
	Stop,
	stopRef,
	stopTimesByStop,
	tripsByKey,
} from "../gtfs";
import { getObaArrivals, getTripUpdates, LiveStatus, obaCovers, StopTimeUpdate, TripUpdate } from "../realtime";
import { em, routeEmoji, scheduledMark } from "../style";
import { prettyTime, serviceDays } from "../time";

export type Arrival = {
	routeKey?: string;
	routeName: string;
	epochMs: number;
	realtime: boolean;
};

export type StopOpts = { agency?: string; near?: Place };

// How far back to look at scheduled times. A bus scheduled 20 minutes ago
// that is running 25 minutes late is still the next bus.
const LOOKBACK_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 4 * 60 * 60 * 1000;
const GRACE_MS = 60 * 1000; // keep a bus for a minute after its arrival time

// GTFS-RT rule: an update applies to its stop and propagates downstream until
// the next update, so a delay reported at an earlier stop still applies here.
const findStopUpdate = (tu: TripUpdate, stopId: string, seq: number) => {
	const updates = tu.stop_time_update ?? [];
	const exact = updates.find(
		(u) => (u.stop_sequence !== undefined && u.stop_sequence === seq) || u.stop_id === stopId,
	);
	if (exact) return { update: exact, exact: true };
	let prior: StopTimeUpdate | undefined;
	for (const u of updates) {
		if (u.stop_sequence !== undefined && u.stop_sequence <= seq) prior = u;
	}
	return prior ? { update: prior, exact: false } : undefined;
};

const gtfsArrivals = async (
	stop: Stop,
	route?: Route,
	nowMs = Date.now(),
): Promise<{ arrivals: Arrival[]; status: LiveStatus }> => {
	const { updates: tripUpdates, status } = await getTripUpdates(stop.agency);
	const arrivals: Arrival[] = [];
	const stopTimes = stopTimesByStop.get(stop.key) ?? [];

	for (const day of serviceDays(nowMs)) {
		for (const st of stopTimes) {
			const scheduledMs = day.startEpochMs + st.arrivalSec * 1000;
			if (scheduledMs < nowMs - LOOKBACK_MS || scheduledMs > nowMs + LOOKAHEAD_MS) continue;
			const trip = tripsByKey.get(st.trip_key);
			if (!trip) continue;
			if (route && trip.route_key !== route.key) continue;
			if (!isServiceActive(trip.service_key, day)) continue;

			let epochMs = scheduledMs;
			let realtime = false;
			const tu = tripUpdates.get(trip.trip_id);
			const tuDate = tu?.trip?.start_date;
			if (tu && (!tuDate || tuDate === day.date)) {
				if (tu.trip.schedule_relationship === "CANCELED") continue;
				const found = findStopUpdate(tu, stop.stop_id, st.stop_sequence);
				if (found) {
					const { update, exact } = found;
					if (exact && update.schedule_relationship === "SKIPPED") continue;
					const event = update.arrival ?? update.departure;
					if (exact && event?.time) {
						epochMs = event.time * 1000;
						realtime = true;
					} else if (event?.delay !== undefined) {
						epochMs = scheduledMs + event.delay * 1000;
						realtime = true;
					}
				}
			}

			if (epochMs < nowMs - GRACE_MS) continue;
			const r = routesByKey.get(trip.route_key);
			arrivals.push({ routeKey: trip.route_key, routeName: shortName(r), epochMs, realtime });
		}
	}
	return { arrivals: arrivals.sort((a, b) => a.epochMs - b.epochMs), status };
};

const obaArrivals = async (stop: Stop, route?: Route, nowMs = Date.now()): Promise<Arrival[]> => {
	const { arrivals } = await getObaArrivals(stop);
	return arrivals
		.filter(
			(a) =>
				!route ||
				a.routeKey === route.key ||
				a.routeShortName.toLowerCase() === shortName(route).toLowerCase(),
		)
		.filter((a) => a.epochMs >= nowMs - GRACE_MS)
		.map((a) => ({ routeKey: a.routeKey, routeName: a.routeShortName, epochMs: a.epochMs, realtime: a.realtime }))
		.sort((a, b) => a.epochMs - b.epochMs);
};

// OneBusAway first, then the agency's GTFS-RT + schedule as the fallback.
// `offline` means live data was expected for this agency but none of its
// sources could be reached, so every time shown is from the schedule.
export const getArrivals = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	const viaOba = obaCovers(stop);
	if (viaOba) {
		try {
			return { arrivals: await obaArrivals(stop, route, nowMs), offline: false };
		} catch (e) {
			console.log("OneBusAway failed, falling back to GTFS:", (e as Error).message);
		}
	}
	const { arrivals, status } = await gtfsArrivals(stop, route, nowMs);
	const expectedLive = viaOba || status !== "none";
	const gotLive = status === "live" || status === "stale";
	return { arrivals, offline: expectedLive && !gotLive };
};

// Last line of a reply when live data couldn't be reached.
export const OFFLINE = () => em("📴", "offline: schedule times only");

const formatArrival = (nowMs: number, a: Arrival) =>
	`${prettyTime(nowMs, a.epochMs)}${a.realtime ? "" : scheduledMark()}`;

export const NO_TRIPS = () => em("😴", "No upcoming trips.");
export const NO_STOP = () => em("❓", "No stop found with that id.");
const NO_ROUTE = () => em("❓", "No route found with that id.");

// " · CT" after the stop name when it isn't the default agency's stop.
export const agencyTag = (stop: Stop) =>
	stop.agency === defaultAgency ? "" : ` · ${agencyCode(stop.agency).toUpperCase()}`;

// When the number exists at other agencies too, say how to reach those.
export const alsoLine = (others: Stop[]) =>
	others.length ? `\nalso: ${others.slice(0, 2).map(stopRef).join(", ")}` : "";

export const busStop = async (typed: string, nowMs = Date.now(), opts: StopOpts = {}) => {
	const found = resolveStop(typed, opts);
	if (!found) return NO_STOP();
	const { stop, others } = found;

	const { arrivals, offline } = await getArrivals(stop, undefined, nowMs);
	const tail = `${offline ? `\n${OFFLINE()}` : ""}${alsoLine(others)}`;
	const nextByRoute = new Map<string, Arrival>();
	for (const a of arrivals) if (!nextByRoute.has(a.routeName)) nextByRoute.set(a.routeName, a);

	let reply = em("🚏", `${stop.stop_name}${agencyTag(stop)}`);
	if (!nextByRoute.size) return `${reply}\n${NO_TRIPS()}${tail}`;
	for (const a of nextByRoute.values()) {
		const icon = routeEmoji(a.routeKey ? routesByKey.get(a.routeKey) : undefined, a.routeName);
		reply += `\n${em(icon, `${a.routeName} - ${formatArrival(nowMs, a)}`)}`;
	}
	return reply + tail;
};

export const busStopAndRoute = async (typed: string, routeName: string, nowMs = Date.now(), opts: StopOpts = {}) => {
	// A route that only exists at another agency's stop with this number
	// should win over the nearest/default pick.
	const found = resolveStop(typed, opts);
	if (!found) return NO_STOP();
	let { stop, others } = found;
	let route = findRoute(routeName, stop);
	if (!route) {
		const alt = others.find((s) => findRoute(routeName, s));
		if (alt) {
			others = [stop, ...others.filter((s) => s.key !== alt.key)];
			stop = alt;
			route = findRoute(routeName, alt);
		}
	}
	if (!route) return NO_ROUTE();

	const result = await getArrivals(stop, route, nowMs);
	const arrivals = result.arrivals.slice(0, 5);
	const tail = result.offline ? `\n${OFFLINE()}` : "";
	let reply = em(routeEmoji(route), `${shortName(route)} @ ${stop.stop_name}${agencyTag(stop)}`);
	if (!arrivals.length) return `${reply}\n${NO_TRIPS()}${tail}`;
	for (const a of arrivals) reply += `\n${formatArrival(nowMs, a)}`;
	return reply + tail;
};
