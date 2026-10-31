import { findRoute, findStop, routesByStop, Route, shortName, Stop } from "../gtfs";
import { Alert, getAlerts, getObaArrivals, obaEnabled, translate } from "../realtime";

const isActive = (alert: Alert, nowMs: number) => {
	const periods = alert.alert.active_period ?? [];
	if (!periods.length) return true;
	const now = nowMs / 1000;
	return periods.some((p) => (!p.start || p.start <= now) && (!p.end || now <= p.end));
};

// An alert applies to a stop if it names the stop, or names a route that
// serves the stop without naming a specific stop (route-wide reroutes etc.).
// The original only matched stop-specific alerts.
const matches = (alert: Alert, stop: Stop, route?: Route) => {
	const served = routesByStop.get(stop.stop_id);
	return (alert.alert.informed_entity ?? []).some((e) => {
		const stopOk = !e.stop_id || e.stop_id === stop.stop_id;
		if (!stopOk) return false;
		if (route) return !e.route_id ? Boolean(e.stop_id) : e.route_id === route.route_id;
		if (e.stop_id) return true;
		return Boolean(e.route_id && served?.has(e.route_id));
	});
};

const alertText = (alert: Alert) =>
	translate(alert.alert.short_header_text) ?? translate(alert.alert.header_text) ?? "Service alert";

const gtfsAlerts = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	const alerts = await getAlerts();
	return [
		...new Set(
			alerts.filter((a) => isActive(a, nowMs) && matches(a, stop, route)).map(alertText),
		),
	];
};

const getStopAlerts = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	// OneBusAway situations only when no route filter: they aren't easily
	// attributable to one route from the arrivals response.
	if (obaEnabled() && !route) {
		try {
			return (await getObaArrivals(stop.stop_id)).alerts;
		} catch (e) {
			console.log("OneBusAway alerts failed, falling back to GTFS-RT:", (e as Error).message);
		}
	}
	return gtfsAlerts(stop, route, nowMs);
};

export const alertsStop = async (stopId: string, nowMs = Date.now()) => {
	const stop = findStop(stopId);
	if (!stop) return "No stop found with that id.";
	const texts = await getStopAlerts(stop, undefined, nowMs);
	return `${stop.stop_name}\n${texts.length ? texts.join("\n") : "No alerts."}`;
};

export const alertsStopAndRoute = async (stopId: string, routeId: string, nowMs = Date.now()) => {
	const stop = findStop(stopId);
	if (!stop) return "No stop found with that id.";
	const route = findRoute(routeId, stop.stop_id);
	if (!route) return "No route found with that id.";
	const texts = await getStopAlerts(stop, route, nowMs);
	return `${stop.stop_name} - ${shortName(route)}\n${texts.length ? texts.join("\n") : "No alerts."}`;
};
