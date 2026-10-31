// Command parsing, kept separate from the radio connection so it can be tested.
import {
	admin,
	alertsStop,
	alertsStopAndRoute,
	beats,
	busStop,
	busStopAndRoute,
	fav,
	help,
	helpAdmin,
	helpAlerts,
	helpBeats,
	helpBus,
	helpFav,
	helpInfo,
	helpStats,
	info,
	ping,
	pong,
	stats,
	stops,
	helpStops,
	helpNear,
	near,
	helpWatch,
	helpCommute,
} from "./commands";
import { commute, unwatch, watch } from "./alarms";
import { go, helpGo } from "./planner";
import { parseStopArgs, Place } from "./gtfs";
import { isAdmin } from "./store";

export type CommandContext = {
	isDM: boolean;
	pubKey?: string; // hex, DMs only
	name?: string;
	// Words riders type for each command (canonical -> typed), sent by the
	// meshcore-bot plugin so help shows e.g. "busalerts" instead of "alerts".
	say?: Record<string, string>;
	// Where the rider is (from their advert), to pick between agencies that
	// share a stop number.
	near?: Place;
};

let validQueryCount = 0;
export const countQuery = () => (validQueryCount += 1);

// Matches on the first *word* only. The original used startsWith, so chatter
// like "information", "pinging", or "busy" in the channel triggered the bot.
export const handleCommand = async (
	rawMessage: string,
	ctx: CommandContext,
): Promise<string | undefined> => {
	const words = rawMessage.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return;
	const [command, ...args] = words;

	try {
		switch (command) {
			case "help": {
				// Accept the rider-facing word too: "help busalerts" -> alerts.
				const typed = args[0];
				const topic = Object.entries(ctx.say ?? {}).find(([, w]) => w === typed)?.[0] ?? typed;
				if (topic === "alerts") return helpAlerts(ctx.say);
				if (topic === "beats") return helpBeats();
				if (topic === "bus") return helpBus(ctx.say);
				if (topic === "fav" || topic === "favs") return helpFav(ctx.say);
				if (topic === "info") return helpInfo();
				if (topic === "stats") return helpStats();
				if (topic === "stops") return helpStops(ctx.say);
				if (topic === "near") return helpNear(ctx.say);
				if (topic === "go") return helpGo(ctx.say);
				if (topic === "watch" || topic === "unwatch") return helpWatch(ctx.say);
				if (topic === "commute") return helpCommute(ctx.say);
				if (topic === "admin" && isAdmin(ctx.pubKey)) return helpAdmin();
				return help(ctx.isDM, ctx.say);
			}
			case "info":
				return info();
			case "bus":
			case "alerts": {
				if (!args.length) return command === "bus" ? helpBus(ctx.say) : helpAlerts(ctx.say);
				// optional agency code first: "bus ct 1120 201"
				const { agency, stop, rest } = parseStopArgs(args);
				if (!stop) return command === "bus" ? helpBus(ctx.say) : helpAlerts(ctx.say);
				const routeName = rest.join(" ");
				const opts = { agency, near: ctx.near };
				if (command === "bus") {
					return routeName ? busStopAndRoute(stop, routeName, Date.now(), opts) : busStop(stop, Date.now(), opts);
				}
				return routeName ? alertsStopAndRoute(stop, routeName, Date.now(), opts) : alertsStop(stop, Date.now(), opts);
			}
			case "stops":
				return args.length ? stops(args.join(" ")) : helpStops(ctx.say);
			case "near":
				return near(args, ctx);
			case "go":
				return go(args, ctx);
			// ride alarms: DMs only, they need to know who to message
			case "watch":
				return ctx.isDM ? watch(args, ctx) : undefined;
			case "unwatch":
				return ctx.isDM ? unwatch(args, ctx) : undefined;
			case "commute":
				return ctx.isDM ? commute(args, ctx) : undefined;
			case "fav":
			case "favs":
			case "favorites":
				return ctx.isDM ? fav(ctx.pubKey, args, ctx.near) : undefined;
			case "block":
			case "unblock":
			case "blocklist":
				// Silently ignored unless it's a DM from an admin key.
				return ctx.isDM && isAdmin(ctx.pubKey) ? admin(command, args) : undefined;
			case "beats":
				return beats();
			case "ping":
				return ping();
			case "pong":
				return pong();
			case "stats":
				return stats(validQueryCount);
			default:
				return;
		}
	} catch (e) {
		console.error(`Error running "${rawMessage}":`, e);
		return "There was an error running this command.";
	}
};

// Splits a reply into evenly sized parts on word boundaries.
// Limits are UTF-8 bytes, because that's what the radio counts: an emoji is
// one character on screen but 4 bytes on the air.
// 150 (max channel message) - 32 (max name) - 3 (": " etc.)
export const MAX_LENGTH = 115;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export const divideReply = (message: string, maxBytes = MAX_LENGTH) => {
	const total = bytes(message);
	if (total <= maxBytes) return [message];
	let parts = Math.ceil(total / maxBytes);
	let target = Math.ceil(total / parts);

	const segmenter = new Intl.Segmenter(process.env.LANGUAGE_CODE ?? "en", { granularity: "word" });
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const replies: string[] = [];
	let current = "";
	const push = () => {
		if (current.trim()) replies.push(current.trim());
		current = "";
	};
	for (const { segment } of segmenter.segment(message)) {
		if (current && bytes(current) + bytes(segment) > target) push();
		if (bytes(segment) <= maxBytes) {
			current += segment;
			continue;
		}
		// A single "word" longer than the limit: split between characters,
		// never inside an emoji.
		for (const { segment: g } of graphemes.segment(segment)) {
			if (bytes(current) + bytes(g) > maxBytes) push();
			current += g;
		}
	}
	push();
	return replies;
};
