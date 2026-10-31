// Offline trip planner: "go pine 4th to madison mlk".
//
// Plans door-to-door from the timetables on the Pi, across every agency,
// with no internet needed (the "works when everything else is down" piece).
// Uses the Connection Scan Algorithm: every timetabled hop between two
// consecutive stops is a "connection", sorted by departure time; scanning
// them once in order finds the earliest arrival, including transfers and
// short walks between nearby stops.
import {
	isServiceActive,
	metersBetween,
	parseStopArgs,
	Place,
	resolveStop,
	routesByKey,
	routesByStop,
	shortName,
	Stop,
	stopRef,
	stopsByKey,
	stopTimesByStop,
	tripsByKey,
} from "./gtfs";
import { geocode, geocodingEnabled, searchStopsByName } from "./commands/stops";
import { notePin } from "./pins";
import { em, routeEmoji } from "./style";
import { localParts, serviceDays, ServiceDay } from "./time";

const HORIZON_MS = 3 * 3600_000; // look this far ahead
const TRANSFER_MS = 2 * 60_000; // buffer when changing vehicles
const FOOTPATH_M = 400; // walk between nearby stops when transferring
const ACCESS_M = 800; // walk from a place to its stops
const WALK_MPS = 1.25 / 1.3; // 1.25 m/s on a street grid ~30% longer than straight
const MAX_CANDIDATES = 40;

// ---------- network (built on first use) ----------

type Net = {
	stops: Stop[];
	index: Map<string, number>;
	lat: Float64Array;
	lon: Float64Array;
	foot: { to: number; sec: number }[][];
	tripKeys: string[];
	// connections, sorted by departure second within the service day
	dep: Int32Array;
	arr: Int32Array;
	from: Int32Array;
	to: Int32Array;
	trip: Int32Array;
};
let net: Net | undefined;

const cellOf = (lat: number, lon: number) => `${Math.floor(lat / 0.004)},${Math.floor(lon / 0.006)}`;

const buildNet = (): Net => {
	const started = Date.now();
	const stops: Stop[] = [];
	const index = new Map<string, number>();
	for (const s of stopsByKey.values()) {
		if (!routesByStop.has(s.key) || !s.stop_lat || !s.stop_lon) continue;
		index.set(s.key, stops.length);
		stops.push(s);
	}
	const lat = Float64Array.from(stops, (s) => parseFloat(s.stop_lat!));
	const lon = Float64Array.from(stops, (s) => parseFloat(s.stop_lon!));

	// Walks between stops within FOOTPATH_M, via a coarse grid.
	const grid = new Map<string, number[]>();
	stops.forEach((_, i) => {
		const c = cellOf(lat[i], lon[i]);
		(grid.get(c) ?? grid.set(c, []).get(c)!).push(i);
	});
	const foot = stops.map((_, i) => {
		const out: { to: number; sec: number }[] = [];
		const cy = Math.floor(lat[i] / 0.004);
		const cx = Math.floor(lon[i] / 0.006);
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				for (const j of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
					if (j === i) continue;
					const m = metersBetween(lat[i], lon[i], lat[j], lon[j]);
					if (m <= FOOTPATH_M) out.push({ to: j, sec: Math.round(m / WALK_MPS) });
				}
		return out;
	});

	// Group stop times by trip, ordered along the trip. Flat number arrays
	// [seq, stop, sec, ...] rather than objects: the full region is millions
	// of stop times, and the Pi's memory matters.
	const byTrip = new Map<string, number[]>();
	for (const [stopKey, times] of stopTimesByStop) {
		const s = index.get(stopKey);
		if (s === undefined) continue;
		for (const t of times) {
			let list = byTrip.get(t.trip_key);
			if (!list) byTrip.set(t.trip_key, (list = []));
			list.push(t.stop_sequence, s, t.arrivalSec);
		}
	}
	const tripKeys: string[] = [];
	let count = 0;
	for (const [key, list] of byTrip) {
		const m = list.length / 3;
		const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => list[a * 3] - list[b * 3]);
		const sortedList: number[] = [];
		for (const i of order) sortedList.push(list[i * 3 + 1], list[i * 3 + 2]); // [stop, sec, ...]
		byTrip.set(key, sortedList);
		count += Math.max(0, m - 1);
	}
	const raw = { dep: new Int32Array(count), arr: new Int32Array(count), from: new Int32Array(count), to: new Int32Array(count), trip: new Int32Array(count) };
	let n = 0;
	let maxSec = 0;
	for (const [key, list] of byTrip) {
		const t = tripKeys.length;
		tripKeys.push(key);
		for (let i = 0; i + 3 < list.length; i += 2) {
			raw.dep[n] = list[i + 1];
			raw.arr[n] = Math.max(list[i + 3], list[i + 1]);
			raw.from[n] = list[i];
			raw.to[n] = list[i + 2];
			raw.trip[n] = t;
			maxSec = Math.max(maxSec, list[i + 1]);
			n++;
		}
	}
	byTrip.clear();
	// Counting sort by departure second (fast for ~1-2 M connections).
	const buckets = new Int32Array(maxSec + 2);
	for (let i = 0; i < n; i++) buckets[raw.dep[i] + 1]++;
	for (let i = 1; i < buckets.length; i++) buckets[i] += buckets[i - 1];
	const sorted = { dep: new Int32Array(n), arr: new Int32Array(n), from: new Int32Array(n), to: new Int32Array(n), trip: new Int32Array(n) };
	for (let i = 0; i < n; i++) {
		const p = buckets[raw.dep[i]]++;
		sorted.dep[p] = raw.dep[i];
		sorted.arr[p] = raw.arr[i];
		sorted.from[p] = raw.from[i];
		sorted.to[p] = raw.to[i];
		sorted.trip[p] = raw.trip[i];
	}
	console.log(`Trip planner ready: ${stops.length} stops, ${n} connections (${Date.now() - started} ms)`);
	return { stops, index, lat, lon, foot, tripKeys, ...sorted };
};

const getNet = () => (net ??= buildNet());
export const resetPlanner = () => (net = undefined); // tests / after reloads
// Build the network in the background at startup so the first rider to ask
// isn't the one who waits for it.
export const warmPlanner = (delayMs = 5000) =>
	setTimeout(() => {
		try {
			getNet();
		} catch (e) {
			console.error("Trip planner build failed:", e);
		}
	}, delayMs).unref();

// ---------- places ----------

type Cands = Map<number, number>; // stop index -> walk seconds
type PlaceResult = { cands: Cands; label: string } | { error: string };

const withinWalk = (n: Net, lat: number, lon: number, maxM = ACCESS_M): Cands => {
	const out: Cands = new Map();
	const scored: [number, number][] = [];
	for (let i = 0; i < n.stops.length; i++) {
		if (Math.abs(n.lat[i] - lat) > 0.012 || Math.abs(n.lon[i] - lon) > 0.018) continue;
		const m = metersBetween(lat, lon, n.lat[i], n.lon[i]);
		if (m <= maxM) scored.push([i, Math.round(m / WALK_MPS)]);
	}
	scored.sort((a, b) => a[1] - b[1]).slice(0, MAX_CANDIDATES).forEach(([i, s]) => out.set(i, s));
	return out;
};

// A stop plus the stops a short walk from it (other side of the street, etc).
const aroundStops = (n: Net, stops: Stop[]): Cands => {
	const out: Cands = new Map();
	for (const s of stops) {
		const i = n.index.get(s.key);
		if (i === undefined) {
			// no scheduled service here (school stop, closed, other direction
			// only): use whatever is served right around it
			const lat = parseFloat(s.stop_lat ?? "");
			const lon = parseFloat(s.stop_lon ?? "");
			if (Number.isFinite(lat) && Number.isFinite(lon))
				for (const [j, sec] of withinWalk(n, lat, lon, 300)) if (sec < (out.get(j) ?? Infinity)) out.set(j, sec);
			continue;
		}
		out.set(i, 0);
		for (const f of n.foot[i]) if (f.sec < (out.get(f.to) ?? Infinity) && f.sec <= 180) out.set(f.to, f.sec);
		if (out.size >= MAX_CANDIDATES) break;
	}
	return out;
};

const shortStop = (s: Stop, max = 28) => (s.stop_name.length > max ? `${s.stop_name.slice(0, max - 1)}…` : s.stop_name);

export const resolvePlace = async (
	text: string,
	ctx: { isDM: boolean; near?: Place },
): Promise<PlaceResult> => {
	const n = getNet();
	const q = text.trim();
	if (/^(here|me|my location|current location)$/i.test(q)) {
		if (!ctx.isDM) return { error: em("📍", `DM me to plan from "here", so your location stays out of the channel.`) };
		if (!ctx.near) return { error: em("📍", "No position in your adverts yet. Use a stop or cross streets instead.") };
		const cands = withinWalk(n, ctx.near.lat, ctx.near.lon);
		return cands.size ? { cands, label: "you" } : { error: em("📍", "No stops within a 10-min walk of your last advert.") };
	}
	// A stop number, optionally with an agency: "1120", "ct 1120"
	const words = q.split(/\s+/);
	const { agency, stop: typed, rest } = parseStopArgs(words);
	if (typed && !rest.length && /\d/.test(typed)) {
		const found = resolveStop(typed, { agency, near: ctx.near });
		if (found) return { cands: aroundStops(n, [found.stop]), label: `${stopRef(found.stop)} ${shortStop(found.stop)}` };
	}
	// Cross streets
	const named = searchStopsByName(q);
	if (named.length) return { cands: aroundStops(n, named.slice(0, 8)), label: shortStop(named[0]) };
	// Address or landmark
	if (!geocodingEnabled()) return { error: em("❓", `Couldn't find "${q}". Try a stop number or cross streets.`) };
	try {
		const place = await geocode(q);
		if (!place) return { error: em("❓", `Couldn't find "${q}" around Puget Sound.`) };
		const cands = withinWalk(n, place.lat, place.lon);
		return cands.size ? { cands, label: q } : { error: em("❓", `No stops within a 10-min walk of "${q}".`) };
	} catch {
		return { error: em("📴", `"${q}" needs an address lookup, which is offline. Try cross streets.`) };
	}
};

// ---------- search ----------

type Leg =
	| { kind: "ride"; trip: string; from: number; to: number; depMs: number; arrMs: number }
	| { kind: "walk"; from: number; to: number; sec: number };
export type Plan = { legs: Leg[]; startWalkSec: number; endWalkSec: number; arriveMs: number; leaveMs: number };

const lowerBound = (a: Int32Array, v: number) => {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

export const planTrip = (origin: Cands, dest: Cands, nowMs: number): Plan | "here" | undefined => {
	const n = getNet();
	for (const s of origin.keys()) if (dest.has(s)) return "here";
	const N = n.stops.length;
	const earliest = new Float64Array(N).fill(Infinity);
	const isOrigin = new Uint8Array(N);
	const via = new Int8Array(N); // 1 ride, 2 walk
	const inConn = new Int32Array(N).fill(-1);
	const inDay = new Int8Array(N);
	const footFrom = new Int32Array(N).fill(-1);
	for (const [s, walk] of origin) {
		earliest[s] = nowMs + walk * 1000;
		isOrigin[s] = 1;
	}
	const days: ServiceDay[] = serviceDays(nowMs);
	const active = days.map(() => new Map<string, boolean>());
	const runs = (trip: number, d: number) => {
		const key = tripsByKey.get(n.tripKeys[trip])!.service_key;
		let v = active[d].get(key);
		if (v === undefined) active[d].set(key, (v = isServiceActive(key, days[d])));
		return v;
	};
	const entered = new Map<number, number>(); // day*trips+trip -> boarding connection
	const T = n.tripKeys.length;
	const horizon = nowMs + HORIZON_MS;
	let best = Infinity;
	let bestStop = -1;
	const ptr = days.map((day) => lowerBound(n.dep, Math.floor((nowMs - day.startEpochMs) / 1000)));
	const absDep = (d: number) => (ptr[d] < n.dep.length ? days[d].startEpochMs + n.dep[ptr[d]] * 1000 : Infinity);

	while (true) {
		// next connection across today's and yesterday's (after-midnight) service
		let d = 0;
		for (let k = 1; k < days.length; k++) if (absDep(k) < absDep(d)) d = k;
		const depMs = absDep(d);
		if (depMs === Infinity || depMs > horizon || depMs >= best) break;
		const c = ptr[d]++;
		const trip = n.trip[c];
		if (!runs(trip, d)) continue;
		const tk = d * T + trip;
		const from = n.from[c];
		if (!entered.has(tk)) {
			const ready = earliest[from] + (isOrigin[from] ? 0 : TRANSFER_MS);
			if (ready > depMs) continue;
			entered.set(tk, c);
		}
		const arrMs = days[d].startEpochMs + n.arr[c] * 1000;
		const to = n.to[c];
		if (arrMs < earliest[to]) {
			earliest[to] = arrMs;
			isOrigin[to] = 0;
			via[to] = 1;
			inConn[to] = c;
			inDay[to] = d;
			const w = dest.get(to);
			if (w !== undefined && arrMs + w * 1000 < best) {
				best = arrMs + w * 1000;
				bestStop = to;
			}
			for (const f of n.foot[to]) {
				const t = arrMs + f.sec * 1000;
				if (t < earliest[f.to]) {
					earliest[f.to] = t;
					isOrigin[f.to] = 0;
					via[f.to] = 2;
					footFrom[f.to] = to;
					const w2 = dest.get(f.to);
					if (w2 !== undefined && t + w2 * 1000 < best) {
						best = t + w2 * 1000;
						bestStop = f.to;
					}
				}
			}
		}
	}
	if (bestStop < 0) return undefined;

	// Walk back from the destination stop to build the legs.
	const legs: Leg[] = [];
	let s = bestStop;
	for (let guard = 0; !isOrigin[s] && guard < 50; guard++) {
		if (via[s] === 2) {
			const prev = footFrom[s];
			legs.unshift({ kind: "walk", from: prev, to: s, sec: Math.round((earliest[s] - earliest[prev]) / 1000) });
			s = prev;
			continue;
		}
		const c = inConn[s];
		const d = inDay[s];
		const enter = entered.get(d * T + n.trip[c])!;
		legs.unshift({
			kind: "ride",
			trip: n.tripKeys[n.trip[c]],
			from: n.from[enter],
			to: s,
			depMs: days[d].startEpochMs + n.dep[enter] * 1000,
			arrMs: days[d].startEpochMs + n.arr[c] * 1000,
		});
		s = n.from[enter];
	}
	const first = legs.find((l) => l.kind === "ride") as Extract<Leg, { kind: "ride" }> | undefined;
	if (!first) return undefined;
	const startWalkSec = origin.get(s) ?? 0;
	return {
		legs,
		startWalkSec,
		endWalkSec: dest.get(bestStop) ?? 0,
		arriveMs: best,
		leaveMs: first.depMs - startWalkSec * 1000,
	};
};

// ---------- reply ----------

const clock = (ms: number) => {
	const { hour, minute } = localParts(ms);
	return `${hour % 12 || 12}:${String(minute).padStart(2, "0")}`;
};
const mins = (sec: number) => Math.max(1, Math.round(sec / 60));

export const formatPlan = (p: Plan, nowMs = Date.now()) => {
	const n = getNet();
	const lines: string[] = [];
	const rides = p.legs.filter((l) => l.kind === "ride").length;
	const total = Math.round((p.arriveMs - nowMs) / 60_000);
	const transfers = rides > 1 ? ` · ${rides - 1} transfer${rides > 2 ? "s" : ""}` : "";
	lines.push(em("🧭", `Arrive ${clock(p.arriveMs)} · ${total} min${transfers} · timetable`));
	const firstRide = p.legs.find((l) => l.kind === "ride") as Extract<Leg, { kind: "ride" }>;
	// Map pins with fixed labels, so each new plan moves the old pins rather
	// than leaving them: where to board, where to get off, then changes.
	const rideLegs = p.legs.filter((l) => l.kind === "ride") as Extract<Leg, { kind: "ride" }>[];
	notePin(n.stops[firstRide.from], "Trip start");
	notePin(n.stops[rideLegs[rideLegs.length - 1].to], "Trip end");
	rideLegs.slice(1).forEach((l, i) => notePin(n.stops[l.from], i ? `Trip change ${i + 1}` : "Trip change"));
	if (p.startWalkSec >= 60) lines.push(em("🚶", `${mins(p.startWalkSec)} min to ${stopRef(n.stops[firstRide.from])}`));
	p.legs.forEach((l, i) => {
		if (l.kind === "walk") {
			lines.push(em("🚶", `${mins(l.sec)} min to ${stopRef(n.stops[l.to])}`));
			return;
		}
		const trip = tripsByKey.get(l.trip)!;
		const route = routesByKey.get(trip.route_key);
		const name = shortName(route);
		const boardAt = i === 0 || p.legs[i - 1]?.kind === "walk" ? ` ${stopRef(n.stops[l.from])}` : "";
		lines.push(em(routeEmoji(route), `${name} ${clock(l.depMs)}${boardAt} → ${shortStop(n.stops[l.to])} ${clock(l.arrMs)}`));
	});
	if (p.endWalkSec >= 60) lines.push(em("🚶", `${mins(p.endWalkSec)} min to destination`));
	return lines.join("\n");
};

// ---------- command ----------

export const go = async (args: string[], ctx: { isDM: boolean; near?: Place; say?: Record<string, string> }, nowMs = Date.now()) => {
	const word = ctx.say?.go ?? "go";
	let text = args.join(" ").trim().replace(/^from\s+/i, "");
	if (!text) return helpGo(ctx.say);
	// "go to X" plans from here
	let fromText: string;
	let toText: string;
	if (/^to\s+/i.test(text)) {
		fromText = "here";
		toText = text.replace(/^to\s+/i, "");
	} else {
		const m = /^(.+?)\s+to\s+(.+)$/i.exec(text);
		if (!m) return `Use: ${word} [from] to [to], e.g. ${word} pine 4th to madison mlk`;
		[, fromText, toText] = m;
	}
	const from = await resolvePlace(fromText, ctx);
	if ("error" in from) return from.error;
	const to = await resolvePlace(toText, ctx);
	if ("error" in to) return to.error;
	if (!from.cands.size || !to.cands.size)
		return em("😴", `No scheduled service at ${!from.cands.size ? fromText : toText}.`);
	const plan = planTrip(from.cands, to.cands, nowMs);
	if (plan === "here") return em("🚶", "Those are within a short walk of each other.");
	if (!plan) return em("😴", "No trip found in the next 3 hours. Try a nearby stop or a bigger place.");
	return formatPlan(plan, nowMs);
};

export const helpGo = (say?: Record<string, string>) => {
	const g = say?.go ?? "go";
	return `${em("🧭", "Plan a trip, works offline:")}\n${g} pine 4th to madison mlk\n${g} 1120 to ct 1120\n${g} to pike place (DM)`;
};
