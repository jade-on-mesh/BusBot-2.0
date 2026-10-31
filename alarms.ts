// Ride alarms: the bot comes to you.
//
//   watch 1120 11        DM me when the next 11 is 5 min from stop 1120
//   watch 1120 11 10m    ...10 min out instead
//   watch                list my watches       unwatch [n]  cancel one or all
//   commute 8:05 1120 11 weekday digest at 8:05
//   commute              list                  commute off [n]
//
// Alarms are DMs nobody just asked for, so they're kept polite on the mesh:
// 3 watches and 2 commutes per rider, a watch fires once and expires after
// 90 minutes, commutes run weekdays only and at most once a day.
//
// tick() runs every 30 s and returns the DMs that are due; the caller sends
// them (directly in standalone mode, or via the outbox the meshcore-bot
// service plugin collects).
import {
	findRoute,
	parseStopArgs,
	Place,
	resolveStop,
	routesByKey,
	shortName,
	stopFromKey,
	stopRef,
} from "./gtfs";
import { busStop, busStopAndRoute, getArrivals } from "./commands/bus";
import { readJson, writeJson } from "./store";
import { em, routeEmoji, scheduledMark } from "./style";
import { localParts, prettyTime, serviceDays } from "./time";

export const MAX_WATCHES = 3;
export const MAX_COMMUTES = 2;
const WATCH_TTL_MS = 90 * 60_000;
const DEFAULT_LEAD_MIN = 5;
const COMMUTE_GRACE_MIN = 10; // still send if we were down at the exact minute

type Watch = {
	id: string;
	pubKey: string;
	name?: string;
	stopKey: string;
	routeKey?: string;
	leadMin: number;
	createdAt: number;
	expiresAt: number;
	ignoreThroughMs: number; // arrivals at or before this were already known when set
};
type Commute = {
	id: string;
	pubKey: string;
	name?: string;
	stopKey: string;
	routeKey?: string;
	minuteOfDay: number;
	lastSent?: string; // YYYYMMDD
};
export type OutgoingDm = { id: string; pubKey: string; name?: string; text: string; at: number };

const FILE = "alarms.json";
const state = readJson<{ watches: Watch[]; commutes: Commute[] }>(FILE, { watches: [], commutes: [] });
const save = () => writeJson(FILE, state);
export const alarmState = state; // for tests

// Queue for API mode; the meshcore-bot service plugin claims from it.
const outbox: OutgoingDm[] = [];
export const claimOutbox = () => outbox.splice(0, outbox.length);

let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

const mine = <T extends { pubKey: string }>(list: T[], pubKey: string) => list.filter((a) => a.pubKey === pubKey);

const describe = (stopKey: string, routeKey?: string) => {
	const stop = stopFromKey(stopKey);
	const route = routeKey ? routesByKey.get(routeKey) : undefined;
	const where = stop ? `${stop.stop_name} (${stopRef(stop)})` : stopKey;
	return route ? `${shortName(route)} @ ${where}` : where;
};

const hhmm = (minuteOfDay: number) =>
	`${Math.floor(minuteOfDay / 60)}:${String(minuteOfDay % 60).padStart(2, "0")}`;

// "8:05", "8:05am", "17:30", "5:30pm", "0805"
export const parseClock = (s: string): number | undefined => {
	const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/i.exec(s.trim());
	if (!m) return undefined;
	let h = parseInt(m[1]);
	const min = m[2] ? parseInt(m[2]) : 0;
	const ap = m[3]?.toLowerCase();
	if (min > 59 || h > 23 || (ap && (h < 1 || h > 12))) return undefined;
	if (ap?.startsWith("p") && h !== 12) h += 12;
	if (ap?.startsWith("a") && h === 12) h = 0;
	return h * 60 + min;
};

const resolveTarget = (args: string[], near?: Place) => {
	const { agency, stop: typed, rest } = parseStopArgs(args);
	if (!typed) return { error: "need a stop" as const };
	const found = resolveStop(typed, { agency, near });
	if (!found) return { error: em("❓", "No stop found with that id.") };
	let stop = found.stop;
	const routeName = rest.join(" ");
	let route = routeName ? findRoute(routeName, stop) : undefined;
	if (routeName && !route) {
		const alt = found.others.find((s) => findRoute(routeName, s));
		if (!alt) return { error: em("❓", "No route found with that id.") };
		stop = alt;
		route = findRoute(routeName, alt);
	}
	return { stop, route };
};

type Ctx = { pubKey?: string; name?: string; near?: Place };

// ---------- watch ----------

export const watch = async (args: string[], ctx: Ctx, nowMs = Date.now()) => {
	if (!ctx.pubKey) return "Alarms work in direct messages only.";
	const watches = mine(state.watches, ctx.pubKey);
	if (!args.length) {
		if (!watches.length) return em("🚨", "No watches. Ex: watch 1120 11");
		return [em("🚨", "Watching:"), ...watches.map((w, i) => `${i + 1}) ${describe(w.stopKey, w.routeKey)} ${w.leadMin}m`)].join("\n");
	}
	if (args[0] === "off" || args[0] === "stop" || args[0] === "cancel") return unwatch(args.slice(1), ctx);
	if (watches.length >= MAX_WATCHES) return `You can have ${MAX_WATCHES} watches. Cancel one with: unwatch [n]`;

	// optional lead time as the last word: "10m", "10min"
	let leadMin = DEFAULT_LEAD_MIN;
	const last = args[args.length - 1];
	const lead = /^(\d{1,2})m(in)?$/.exec(last);
	if (lead) {
		leadMin = Math.max(1, Math.min(30, parseInt(lead[1])));
		args = args.slice(0, -1);
	}
	const target = resolveTarget(args, ctx.near);
	if ("error" in target) return target.error === "need a stop" ? "Use: watch [stop] [route] [10m]" : target.error;
	const { stop, route } = target;

	// If a bus is already inside the window, say so and watch for the one after.
	const { arrivals } = await getArrivals(stop, route, nowMs);
	const soon = arrivals.find((a) => a.epochMs - nowMs <= leadMin * 60_000);
	const w: Watch = {
		id: newId(),
		pubKey: ctx.pubKey,
		name: ctx.name,
		stopKey: stop.key,
		routeKey: route?.key,
		leadMin,
		createdAt: nowMs,
		expiresAt: nowMs + WATCH_TTL_MS,
		ignoreThroughMs: soon ? soon.epochMs : 0,
	};
	state.watches.push(w);
	save();
	const what = route ? shortName(route) : "the next bus";
	const heads = soon
		? `\n${soon.routeName} is ${prettyTime(nowMs, soon.epochMs)} away now, so I'll DM you about the one after.`
		: "";
	return em("🚨", `Watching ${describe(stop.key, route?.key)}. I'll DM you when ${what} is ${leadMin} min away.${heads}`);
};

export const unwatch = (args: string[], ctx: Ctx) => {
	if (!ctx.pubKey) return "Alarms work in direct messages only.";
	const watches = mine(state.watches, ctx.pubKey);
	if (!watches.length) return "No watches to cancel.";
	const n = parseInt(args[0]);
	const gone = args.length && !isNaN(n) ? watches.slice(n - 1, n) : watches;
	if (!gone.length) return `Use: unwatch [1-${watches.length}], or unwatch for all`;
	const ids = new Set(gone.map((w) => w.id));
	state.watches = state.watches.filter((w) => !ids.has(w.id));
	save();
	return em("🗑️", gone.length === 1 ? `Stopped watching ${describe(gone[0].stopKey, gone[0].routeKey)}.` : "Stopped all watches.");
};

// ---------- commute ----------

export const commute = async (args: string[], ctx: Ctx) => {
	if (!ctx.pubKey) return "Alarms work in direct messages only.";
	const commutes = mine(state.commutes, ctx.pubKey);
	if (!args.length || args[0] === "list") {
		if (!commutes.length) return em("⏰", "No commutes. Ex: commute 8:05 1120 11");
		return [em("⏰", "Weekday commutes:"), ...commutes.map((c, i) => `${i + 1}) ${hhmm(c.minuteOfDay)} ${describe(c.stopKey, c.routeKey)}`)].join("\n");
	}
	if (args[0] === "off" || args[0] === "stop" || args[0] === "cancel" || args[0] === "rm") {
		if (!commutes.length) return "No commutes to cancel.";
		const n = parseInt(args[1]);
		const gone = args[1] && !isNaN(n) ? commutes.slice(n - 1, n) : commutes;
		if (!gone.length) return `Use: commute off [1-${commutes.length}], or commute off for all`;
		const ids = new Set(gone.map((c) => c.id));
		state.commutes = state.commutes.filter((c) => !ids.has(c.id));
		save();
		return em("🗑️", gone.length === 1 ? `Cancelled ${hhmm(gone[0].minuteOfDay)} commute.` : "Cancelled all commutes.");
	}
	const minuteOfDay = parseClock(args[0]);
	if (minuteOfDay === undefined) return "Use: commute [time] [stop] [route], e.g. commute 8:05 1120 11";
	if (commutes.length >= MAX_COMMUTES) return `You can have ${MAX_COMMUTES} commutes. Cancel one with: commute off [n]`;
	const target = resolveTarget(args.slice(1), ctx.near);
	if ("error" in target) return target.error === "need a stop" ? "Use: commute [time] [stop] [route]" : target.error;
	state.commutes.push({
		id: newId(),
		pubKey: ctx.pubKey,
		name: ctx.name,
		stopKey: target.stop.key,
		routeKey: target.route?.key,
		minuteOfDay,
	});
	save();
	return em("⏰", `Weekdays at ${hhmm(minuteOfDay)} I'll DM you ${describe(target.stop.key, target.route?.key)}.`);
};

// ---------- scheduler ----------

const isWeekday = (weekday: string) => !["saturday", "sunday"].includes(weekday);

// Works out which alarms are due and returns their DMs (also queued in the
// outbox for API mode). Safe to call often; each alarm fires once.
export const tick = async (nowMs = Date.now()): Promise<OutgoingDm[]> => {
	const due: OutgoingDm[] = [];
	const send = (a: { pubKey: string; name?: string }, text: string) =>
		due.push({ id: newId(), pubKey: a.pubKey, name: a.name, text, at: nowMs });
	let changed = false;

	for (const w of [...state.watches]) {
		const stop = stopFromKey(w.stopKey);
		const route = w.routeKey ? routesByKey.get(w.routeKey) : undefined;
		const drop = () => {
			state.watches = state.watches.filter((x) => x.id !== w.id);
			changed = true;
		};
		if (!stop || (w.routeKey && !route)) {
			drop(); // stop or route vanished in a schedule update
			continue;
		}
		if (nowMs > w.expiresAt) {
			send(w, em("⌛", `Watch ended: no ${route ? shortName(route) : "bus"} came within 90 min at ${stop.stop_name}.`));
			drop();
			continue;
		}
		try {
			const { arrivals } = await getArrivals(stop, route, nowMs);
			const next = arrivals.find((a) => a.epochMs > w.ignoreThroughMs);
			if (next && next.epochMs - nowMs <= w.leadMin * 60_000) {
				const icon = routeEmoji(next.routeKey ? routesByKey.get(next.routeKey) : undefined, next.routeName);
				const when = prettyTime(nowMs, next.epochMs);
				const sched = next.realtime ? "" : scheduledMark();
				send(w, em(icon, `${next.routeName} ${when === "now" ? "is arriving" : `in ${when}`}${sched} at ${stop.stop_name}`));
				drop();
			}
		} catch (e) {
			console.log("Watch check failed:", (e as Error).message);
		}
	}

	const today = serviceDays(nowMs)[0];
	const { hour, minute } = localParts(nowMs);
	const nowMinute = hour * 60 + minute;
	if (isWeekday(today.weekday)) {
		for (const c of state.commutes) {
			if (c.lastSent === today.date) continue;
			if (nowMinute < c.minuteOfDay || nowMinute > c.minuteOfDay + COMMUTE_GRACE_MIN) continue;
			const stop = stopFromKey(c.stopKey);
			const route = c.routeKey ? routesByKey.get(c.routeKey) : undefined;
			if (!stop) continue;
			const board = route
				? await busStopAndRoute(stop.stop_id, shortName(route), nowMs, { agency: stop.agency })
				: await busStop(stop.stop_id, nowMs, { agency: stop.agency });
			send(c, `${em("⏰", "Commute")}\n${board}`);
			c.lastSent = today.date;
			changed = true;
		}
	}

	if (changed) save();
	outbox.push(...due);
	if (outbox.length > 200) outbox.splice(0, outbox.length - 200); // nobody collecting
	return due;
};

let timer: NodeJS.Timeout | undefined;
export const startAlarms = (deliver?: (dm: OutgoingDm) => Promise<unknown>, everyMs = 30_000) => {
	if (timer) return;
	let running = false;
	timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			const due = await tick();
			if (deliver) {
				claimOutbox(); // delivered directly; nothing for the outbox
				for (const dm of due) await deliver(dm).catch((e) => console.log("Alarm DM failed:", e));
			}
		} finally {
			running = false;
		}
	}, everyMs);
	timer.unref();
};
