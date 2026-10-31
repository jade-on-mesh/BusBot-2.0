// "stops [cross streets | address | place]" — find stop numbers without
// reading the sign.
//
// 1. Cross streets: Metro names stops after their intersection
//    ("Pine St & 4th Ave"), so a word match over stop names answers most
//    questions instantly and offline.
// 2. Anything else: geocode it (OpenStreetMap Nominatim, limited to the
//    Puget Sound region) and return the closest stops by distance, across
//    every loaded agency.
import { metersBetween, routesByKey, routesByStop, shortName, Stop, stopRef, stopsByKey, tripsByKey } from "../gtfs";
import { notePin } from "../pins";
import { em } from "../style";

const MAX_RESULTS = 3;
// "Nearest" stops further than this aren't useful answers to "stops near X".
const MAX_NEAREST_METERS = 2 * 1609.34;
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
	const hits: { stop: Stop; extra: number }[] = [];
	for (const stop of stopsByKey.values()) {
		if (!routesByStop.has(stop.key)) continue; // no service
		const words = tokens(stop.stop_name);
		if (q.every((t) => words.some((w) => wordMatches(t, w)))) {
			hits.push({ stop, extra: words.length - q.length });
		}
	}
	// Tightest names first ("Pine St & 4th Ave" before "Pine St & 4th Ave - Bay 3"),
	// then by number so results are stable.
	hits.sort((a, b) => a.extra - b.extra || a.stop.key.localeCompare(b.stop.key, undefined, { numeric: true }));
	return hits.map((h) => h.stop);
};

// ---------- typos ----------
//
// "akai beach", "alkai beach" -> "alki beach". Each word that isn't a known
// word gets the closest one from the stop names, trip headsigns and route
// names of every loaded agency (plus common place words), so it works
// offline. Used only when the query as typed finds nothing.

// Words riders use for places that stop names rarely contain.
const PLACE_WORDS =
	"beach park market station terminal ferry dock pier airport university college school hospital center centre " +
	"mall library stadium field arena zoo museum garden gardens lake bay island point tower plaza square " +
	"downtown waterfront transit hub junction landing harbor marina trail bridge church hall court courthouse " +
	"high middle elementary campus clinic medical theater theatre north south east west";

let vocab: Map<string, number> | undefined;
const getVocab = () => {
	if (vocab) return vocab;
	const counts = new Map<string, number>();
	const add = (text?: string) => {
		for (const t of tokens(text ?? "")) if (t.length >= 3 && !/\d/.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
	};
	for (const stop of stopsByKey.values()) add(stop.stop_name);
	for (const trip of tripsByKey.values()) add(trip.trip_headsign);
	for (const route of routesByKey.values()) add(route.route_long_name);
	add(PLACE_WORDS);
	for (const w of Object.keys(ABBREVIATIONS)) counts.delete(w); // these always become their short form
	return (vocab = counts);
};
export const resetVocab = () => (vocab = undefined);

// Edit distance counting a swap of two neighbouring letters as one edit
// ("alki" / "alik"), stopping early once it exceeds [max].
const editDistance = (a: string, b: string, max: number) => {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const rows: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		rows.push([i]);
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			if (i === 0) {
				rows[0][j] = j;
				continue;
			}
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
			rows[i][j] = d;
			best = Math.min(best, d);
		}
		if (i > 0 && best > max) return max + 1;
	}
	return rows[a.length][b.length];
};

// The known word a typo most likely meant, or the word itself.
export const correctWord = (word: string): string => {
	const words = getVocab();
	if (word.length < 4 || /\d/.test(word) || words.has(word) || IGNORED.has(word)) return word;
	// Short words get one edit, or two if the first letter is right
	// ("akai" -> "alki"); longer words get two.
	let best: { w: string; score: number } | undefined;
	for (const [w, count] of words) {
		if (Math.abs(w.length - word.length) > 2) continue;
		const d = editDistance(word, w, 2);
		if (d > 2) continue;
		const sameStart = w[0] === word[0];
		if (d === 2 && word.length < 6 && !sameStart) continue;
		// fewer edits first, then same first letter, then common words
		const score = d * 1000 - (sameStart ? 500 : 0) - Math.min(count, 499);
		if (!best || score < best.score) best = { w, score };
	}
	return best?.w ?? word;
};

// The query with each unknown word corrected, or undefined if nothing changed.
export const correctQuery = (query: string): string | undefined => {
	const words = tokens(query);
	const fixed = words.map(correctWord);
	return fixed.some((w, i) => w !== words[i]) ? fixed.join(" ") : undefined;
};

// Name search that retries with typos corrected. [query] is what matched.
export const searchStopsFuzzy = (query: string): { stops: Stop[]; query: string } => {
	const exact = searchStopsByName(query);
	if (exact.length) return { stops: exact, query };
	const fixed = correctQuery(query);
	if (fixed) {
		const hits = searchStopsByName(fixed);
		if (hits.length) return { stops: hits, query: fixed };
	}
	return { stops: [], query };
};

// Geocode as typed, then with typos corrected (an address lookup needs every
// word to match, so a typo usually finds nothing rather than somewhere wrong).
export const geocodeFuzzy = async (query: string): Promise<Geo | null> => {
	const place = await geocode(query);
	if (place) return place;
	const fixed = correctQuery(query);
	return fixed ? geocode(fixed) : null;
};

// ---------- geocoding ----------

// Bounding box around the Puget Sound region (Olympia to Everett, Kitsap to
// the Cascades): west, north, east, south. GEOCODE_VIEWBOX overrides it.
const REGION_VIEWBOX = process.env.GEOCODE_VIEWBOX || "-123.25,48.30,-121.30,46.85";
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
		viewbox: REGION_VIEWBOX,
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

export const nearestStops = (lat: number, lon: number, count = MAX_RESULTS) => {
	const all: { stop: Stop; meters: number }[] = [];
	for (const stop of stopsByKey.values()) {
		if (!routesByStop.has(stop.key) || !stop.stop_lat || !stop.stop_lon) continue;
		all.push({ stop, meters: metersBetween(lat, lon, parseFloat(stop.stop_lat), parseFloat(stop.stop_lon)) });
	}
	return all
		.filter((s) => s.meters <= MAX_NEAREST_METERS)
		.sort((a, b) => a.meters - b.meters)
		.slice(0, count);
};

// US riders: feet up close, miles further out.
const formatDistance = (meters: number) => {
	const feet = meters * 3.28084;
	if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
	return `${(meters / 1609.34).toFixed(1)} mi`;
};

// ---------- output ----------

const routeList = (stopKey: string) => {
	const names = [...new Set([...(routesByStop.get(stopKey) ?? [])].map((k) => shortName(routesByKey.get(k))))]
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const shown = names.slice(0, MAX_ROUTES_SHOWN).join(", ");
	return names.length > MAX_ROUTES_SHOWN ? `${shown} +${names.length - MAX_ROUTES_SHOWN}` : shown;
};

const stopLine = (stop: Stop, distance?: string) => {
	notePin(stop);
	return em("🚏", `${stopRef(stop)} ${stop.stop_name}${distance ? ` · ${distance}` : ""} → ${routeList(stop.key)}`);
};

const shorten = (s: string, max = 32) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const stops = async (query: string) => {
	const q = query.trim();
	if (!q) return helpStops();

	const { stops: byName, query: matched } = searchStopsFuzzy(q);
	if (byName.length) {
		const more = byName.length > MAX_RESULTS ? ` (${byName.length} found)` : "";
		return [em("🔎", `${shorten(matched)}${more}:`), ...byName.slice(0, MAX_RESULTS).map((s) => stopLine(s))].join("\n");
	}

	if (!geocodingEnabled()) return em("❓", "No stops match that. Try cross streets, e.g. stops pine 4th");
	let place: Geo | null;
	try {
		place = await geocodeFuzzy(q);
	} catch (e) {
		console.log("Geocoding failed:", (e as Error).message);
		return em("📴", "No stop names match, and address lookup is offline. Try cross streets, e.g. stops pine 4th");
	}
	if (!place) return em("❓", "Couldn't find that around Puget Sound. Try cross streets, e.g. stops pine 4th");
	const near = nearestStops(place.lat, place.lon);
	if (!near.length) return em("❓", "No stops with service within 2 miles of there.");
	return [
		em("🔎", `Near ${shorten(place.label)}:`),
		...near.map(({ stop, meters }) => stopLine(stop, formatDistance(meters))),
	].join("\n");
};

export const helpStops = (say?: Record<string, string>) => {
	const s = say?.stops ?? "stops";
	return `${em("🔎", "Find stop numbers. Ex:")}\n${s} pine 4th\n${s} 1100 broadway\n${s} pike place market`;
};

// "near": the stops closest to where the rider's radio last advertised.
// Bare "near" is DM-only: answering in a channel would tell everyone where
// the rider is. "near [place]" reveals nothing about them and works anywhere.
export const near = async (args: string[], ctx: { isDM: boolean; near?: { lat: number; lon: number }; say?: Record<string, string> }) => {
	if (args.length) return stops(args.join(" "));
	const word = ctx.say?.near ?? "near";
	if (!ctx.isDM) return em("📍", `DM me "${word}" for stops near you, so your location stays out of the channel.`);
	if (!ctx.near) {
		return em("📍", `No position in your adverts yet. Turn on location sharing in your radio's settings, or try: ${ctx.say?.stops ?? "stops"} pine 4th`);
	}
	const found = nearestStops(ctx.near.lat, ctx.near.lon);
	if (!found.length) return em("📍", "No stops with service within 2 miles of your last advert.");
	return [em("📍", "Near you:"), ...found.map(({ stop, meters }) => stopLine(stop, formatDistance(meters)))].join("\n");
};

export const helpNear = (say?: Record<string, string>) => {
	const n = say?.near ?? "near";
	return `${em("📍", "Stops closest to your radio (DM):")}\n${n}\n${n} [place] works anywhere:\n${n} pike place market`;
};
