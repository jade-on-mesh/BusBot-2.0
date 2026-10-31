// "stops [cross streets | address | place]" — find stop numbers without
// reading the sign.
//
// 1. Cross streets: Metro names stops after their intersection
//    ("Pine St & 4th Ave"), so a word match over stop names answers most
//    questions instantly and offline.
// 2. Anything else: geocode it (OpenStreetMap Nominatim, limited to King
//    County) and return the closest stops by distance.
import { routesById, routesByStop, shortName, Stop, stopsById } from "../gtfs";
import { em } from "../style";

const MAX_RESULTS = 3;
const MAX_ROUTES_SHOWN = 4;

// ---------- name search ----------

const ABBREVIATIONS: Record<string, string> = {
	street: "st", avenue: "ave", av: "ave", boulevard: "blvd", place: "pl", drive: "dr",
	road: "rd", lane: "ln", court: "ct", parkway: "pkwy", highway: "hwy", terrace: "ter",
	circle: "cir", square: "sq", station: "sta", north: "n", south: "s", east: "e", west: "w",
	northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
	first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th",
	seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th", mlk: "martin",
};
const IGNORED = new Set(["and", "at", "the", "of", "near", "by", "on"]);

const tokens = (s: string) =>
	s
		.toLowerCase()
		.replace(/['’.]/g, "")
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((t) => ABBREVIATIONS[t] ?? t);

// A query word matches a name word if equal, a prefix of it ("pin" ~ "pine"),
// or a bare number matching an ordinal ("4" ~ "4th"). One- and two-letter
// words (directions like "e", "ne") must match exactly.
const wordMatches = (q: string, w: string) => {
	if (q === w) return true;
	if (/^\d+$/.test(q)) return new RegExp(`^${q}(st|nd|rd|th)$`).test(w);
	return q.length >= 3 && w.startsWith(q);
};

export const searchStopsByName = (query: string): Stop[] => {
	const q = tokens(query).filter((t) => !IGNORED.has(t));
	// Need at least one real word or number; "e" or "ne" alone matches half the county.
	if (!q.some((t) => t.length >= 3 || /^\d+$/.test(t))) return [];
	const seen = new Set<string>();
	const hits: { stop: Stop; extra: number }[] = [];
	for (const stop of stopsById.values()) {
		if (seen.has(stop.stop_id)) continue; // stopsById also holds stop_code aliases
		seen.add(stop.stop_id);
		if (!routesByStop.has(stop.stop_id)) continue; // no service
		const words = tokens(stop.stop_name);
		if (q.every((t) => words.some((w) => wordMatches(t, w)))) {
			hits.push({ stop, extra: words.length - q.length });
		}
	}
	// Tightest names first ("Pine St & 4th Ave" before "Pine St & 4th Ave - Bay 3"),
	// then by number so results are stable.
	hits.sort((a, b) => a.extra - b.extra || a.stop.stop_id.localeCompare(b.stop.stop_id, undefined, { numeric: true }));
	return hits.map((h) => h.stop);
};

// ---------- geocoding ----------

// Bounding box around King County: west, north, east, south.
const KING_COUNTY_VIEWBOX = "-122.55,47.79,-121.06,47.08";
const geocodeCache = new Map<string, { at: number; value: Geo | null }>();
let lastGeocodeAt = 0;

type Geo = { lat: number; lon: number; label: string };

export const geocodingEnabled = () => !/^(0|false|off|no)$/i.test((process.env.GEOCODE ?? "").trim());

// Nominatim's usage policy: identify the app, at most one request per second,
// cache results. GEOCODER_URL can point at a self-hosted Nominatim instead.
export const geocode = async (query: string): Promise<Geo | null> => {
	const key = query.trim().toLowerCase();
	const hit = geocodeCache.get(key);
	if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.value;

	const wait = lastGeocodeAt + 1100 - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastGeocodeAt = Date.now();

	const base = (process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
	const params = new URLSearchParams({
		q: query,
		format: "jsonv2",
		limit: "1",
		countrycodes: "us",
		viewbox: KING_COUNTY_VIEWBOX,
		bounded: "1",
	});
	if (process.env.GEOCODER_EMAIL) params.set("email", process.env.GEOCODER_EMAIL);
	const res = await fetch(`${base}/search?${params}`, {
		headers: { "User-Agent": "BusBot-2.0 (https://github.com/jade-on-mesh/BusBot-2.0)" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
	const [first] = (await res.json()) as { lat: string; lon: string; display_name?: string; name?: string }[];
	const value = first
		? { lat: parseFloat(first.lat), lon: parseFloat(first.lon), label: first.name || first.display_name || query }
		: null;
	geocodeCache.set(key, { at: Date.now(), value });
	if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value!);
	return value;
};

const metersBetween = (lat1: number, lon1: number, lat2: number, lon2: number) => {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLon = (lon2 - lon1) * rad;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
	return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
};

export const nearestStops = (lat: number, lon: number, count = MAX_RESULTS) => {
	const seen = new Set<string>();
	const all: { stop: Stop; meters: number }[] = [];
	for (const stop of stopsById.values()) {
		if (seen.has(stop.stop_id)) continue;
		seen.add(stop.stop_id);
		if (!routesByStop.has(stop.stop_id) || !stop.stop_lat || !stop.stop_lon) continue;
		all.push({ stop, meters: metersBetween(lat, lon, parseFloat(stop.stop_lat), parseFloat(stop.stop_lon)) });
	}
	return all.sort((a, b) => a.meters - b.meters).slice(0, count);
};

// US riders: feet up close, miles further out.
const formatDistance = (meters: number) => {
	const feet = meters * 3.28084;
	if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
	return `${(meters / 1609.34).toFixed(1)} mi`;
};

// ---------- output ----------

const routeList = (stopId: string) => {
	const names = [...(routesByStop.get(stopId) ?? [])]
		.map((id) => shortName(routesById.get(id)))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const shown = names.slice(0, MAX_ROUTES_SHOWN).join(", ");
	return names.length > MAX_ROUTES_SHOWN ? `${shown} +${names.length - MAX_ROUTES_SHOWN}` : shown;
};

const stopLine = (stop: Stop, distance?: string) =>
	em("🚏", `${stop.stop_id} ${stop.stop_name}${distance ? ` · ${distance}` : ""} → ${routeList(stop.stop_id)}`);

const shorten = (s: string, max = 32) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const stops = async (query: string) => {
	const q = query.trim();
	if (!q) return helpStops();

	const byName = searchStopsByName(q);
	if (byName.length) {
		const more = byName.length > MAX_RESULTS ? ` (${byName.length} found)` : "";
		return [em("🔎", `${shorten(q)}${more}:`), ...byName.slice(0, MAX_RESULTS).map((s) => stopLine(s))].join("\n");
	}

	if (!geocodingEnabled()) return em("❓", "No stops match that. Try cross streets, e.g. stops pine 4th");
	let place: Geo | null;
	try {
		place = await geocode(q);
	} catch (e) {
		console.log("Geocoding failed:", (e as Error).message);
		return em("❓", "No stop names match, and address lookup is unavailable right now.");
	}
	if (!place) return em("❓", "Couldn't find that in King County. Try cross streets, e.g. stops pine 4th");
	const near = nearestStops(place.lat, place.lon);
	if (!near.length) return em("❓", "No stops with service near there.");
	return [
		em("🔎", `Near ${shorten(place.label)}:`),
		...near.map(({ stop, meters }) => stopLine(stop, formatDistance(meters))),
	].join("\n");
};

export const helpStops = () =>
	"Find stop numbers. Cross streets or an address. Ex:\nstops pine 4th\nstops broadway madison\nstops 1100 broadway\nstops pike place market";
