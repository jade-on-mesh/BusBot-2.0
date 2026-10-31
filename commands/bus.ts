import { findRoute, findStop, isServiceActive, Route, routesById, shortName, Stop, stopTimesByStop, tripsById } from "../gtfs";
import { getObaArrivals, getTripUpdates, obaEnabled, StopTimeUpdate, TripUpdate } from "../realtime";
import { em, routeEmoji, scheduledMark } from "../style";
import { prettyTime, serviceDays } from "../time";

export type Arrival = {
	routeId: string;
	routeName: string;
	epochMs: number;
	realtime: boolean;
};

// How far back to look at scheduled times. A bus scheduled 20 minutes ago
// that is running 25 minutes late is still the next bus — the original code
// filtered on scheduled time >= now, which is why it "skipped the first bus".
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

const gtfsArrivals = async (stop: Stop, route?: Route, nowMs = Date.now()): Promise<Arrival[]> => {
	const tripUpdates = await getTripUpdates();
	const arrivals: Arrival[] = [];
	const stopTimes = stopTimesByStop.get(stop.stop_id) ?? [];

	for (const day of serviceDays(nowMs)) {
		for (const st of stopTimes) {
			const scheduledMs = day.startEpochMs + st.arrivalSec * 1000;
			if (scheduledMs < nowMs - LOOKBACK_MS || scheduledMs > nowMs + LOOKAHEAD_MS) continue;
			const trip = tripsById.get(st.trip_id);
			if (!trip) continue;
			if (route && trip.route_id !== route.route_id) continue;
			if (!isServiceActive(trip.service_id, day)) continue;

			let epochMs = scheduledMs;
			let realtime = false;
			const tu = tripUpdates.get(trip.trip_id);
			const tuDate = (tu?.trip as any)?.start_date;
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
			const r = routesById.get(trip.route_id);
			arrivals.push({ routeId: trip.route_id, routeName: shortName(r), epochMs, realtime });
		}
	}
	return arrivals.sort((a, b) => a.epochMs - b.epochMs);
};

const obaArrivals = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	const { arrivals } = await getObaArrivals(stop.stop_id);
	return arrivals
		.filter(
			(a) =>
				!route ||
				a.routeId === route.route_id ||
				a.routeShortName.toLowerCase() === shortName(route).toLowerCase(),
		)
		.filter((a) => a.epochMs >= nowMs - GRACE_MS)
		.map((a) => ({
			routeId: a.routeId,
			routeName: a.routeShortName,
			epochMs: a.epochMs,
			realtime: a.realtime,
		}))
		.sort((a, b) => a.epochMs - b.epochMs);
};

// OneBusAway first (issue #1), then GTFS-RT + schedule as the fallback.
export const getArrivals = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	if (obaEnabled()) {
		try {
			return await obaArrivals(stop, route, nowMs);
		} catch (e) {
			console.log("OneBusAway failed, falling back to GTFS:", (e as Error).message);
		}
	}
	return gtfsArrivals(stop, route, nowMs);
};

const formatArrival = (nowMs: number, a: Arrival) =>
	`${prettyTime(nowMs, a.epochMs)}${a.realtime ? "" : scheduledMark()}`;

const NO_TRIPS = () => em("😴", "No upcoming trips.");
const NO_STOP = () => em("❓", "No stop found with that id.");
const NO_ROUTE = () => em("❓", "No route found with that id.");

export const busStop = async (stopId: string, nowMs = Date.now()) => {
	const stop = findStop(stopId);
	if (!stop) return NO_STOP();

	const arrivals = await getArrivals(stop, undefined, nowMs);
	const nextByRoute = new Map<string, Arrival>();
	for (const a of arrivals) if (!nextByRoute.has(a.routeName)) nextByRoute.set(a.routeName, a);

	let reply = em("🚏", stop.stop_name);
	if (!nextByRoute.size) return `${reply}\n${NO_TRIPS()}`;
	for (const a of nextByRoute.values()) {
		const icon = routeEmoji(routesById.get(a.routeId), a.routeName);
		reply += `\n${em(icon, `${a.routeName} - ${formatArrival(nowMs, a)}`)}`;
	}
	return reply;
};

export const busStopAndRoute = async (stopId: string, routeId: string, nowMs = Date.now()) => {
	const stop = findStop(stopId);
	if (!stop) return NO_STOP();
	const route = findRoute(routeId, stop.stop_id);
	if (!route) return NO_ROUTE();

	const arrivals = (await getArrivals(stop, route, nowMs)).slice(0, 5);
	let reply = em(routeEmoji(route), `${shortName(route)} @ ${stop.stop_name}`);
	if (!arrivals.length) return `${reply}\n${NO_TRIPS()}`;
	for (const a of arrivals) reply += `\n${formatArrival(nowMs, a)}`;
	return reply;
};
