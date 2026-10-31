import { findRoute, resolveStop, Route, routesByStop, shortName, Stop } from "../gtfs";
import { Alert, getAlertsFor, getObaArrivals, obaEnabled, translate } from "../realtime";
import { em } from "../style";
import { agencyTag, alsoLine, NO_STOP, StopOpts } from "./bus";

const body = (texts: string[]) =>
	texts.length ? texts.map((t) => em("⚠️", t)).join("\n") : em("✅", "No alerts.");

const isActive = (alert: Alert, nowMs: number) => {
	const periods = alert.alert.active_period ?? [];
	if (!periods.length) return true;
	const now = nowMs / 1000;
	return periods.some((p) => (!p.start || p.start <= now) && (!p.end || now <= p.end));
};

// An alert applies to a stop if it names the stop, or names a route that
// serves the stop without naming a specific stop (route-wide reroutes etc.).
// Ids in an alert are the agency's own, so compare within the stop's agency.
const matches = (alert: Alert, stop: Stop, route?: Route) => {
	if (alert.agency !== stop.agency) return false;
	const served = routesByStop.get(stop.key);
	return (alert.alert.informed_entity ?? []).some((e) => {
		const stopOk = !e.stop_id || e.stop_id === stop.stop_id;
		if (!stopOk) return false;
		if (route) return !e.route_id ? Boolean(e.stop_id) : e.route_id === route.route_id;
		if (e.stop_id) return true;
		return Boolean(e.route_id && served?.has(`${stop.agency}:${e.route_id}`));
	});
};

const alertText = (alert: Alert) =>
	translate(alert.alert.short_header_text) ?? translate(alert.alert.header_text) ?? "Service alert";

const gtfsAlerts = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	const alerts = await getAlertsFor(stop.agency);
	return [...new Set(alerts.filter((a) => isActive(a, nowMs) && matches(a, stop, route)).map(alertText))];
};

const getStopAlerts = async (stop: Stop, route?: Route, nowMs = Date.now()) => {
	// OneBusAway situations only when no route filter: they aren't easily
	// attributable to one route from the arrivals response.
	if (obaEnabled() && !route) {
		try {
			return (await getObaArrivals(stop)).alerts;
		} catch (e) {
			console.log("OneBusAway alerts failed, falling back to GTFS-RT:", (e as Error).message);
		}
	}
	return gtfsAlerts(stop, route, nowMs);
};

export const alertsStop = async (typed: string, nowMs = Date.now(), opts: StopOpts = {}) => {
	const found = resolveStop(typed, opts);
	if (!found) return NO_STOP();
	const { stop, others } = found;
	const texts = await getStopAlerts(stop, undefined, nowMs);
	return `${em("🚏", `${stop.stop_name}${agencyTag(stop)}`)}\n${body(texts)}${alsoLine(others)}`;
};

export const alertsStopAndRoute = async (typed: string, routeName: string, nowMs = Date.now(), opts: StopOpts = {}) => {
	const found = resolveStop(typed, opts);
	if (!found) return NO_STOP();
	let { stop } = found;
	let route = findRoute(routeName, stop);
	if (!route) {
		const alt = found.others.find((s) => findRoute(routeName, s));
		if (alt) {
			stop = alt;
			route = findRoute(routeName, alt);
		}
	}
	if (!route) return em("❓", "No route found with that id.");
	const texts = await getStopAlerts(stop, route, nowMs);
	return `${em("🚏", `${shortName(route)} @ ${stop.stop_name}${agencyTag(stop)}`)}\n${body(texts)}`;
};
