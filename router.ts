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
} from "./commands";
import { isAdmin } from "./store";

export type CommandContext = {
	isDM: boolean;
	pubKey?: string; // hex, DMs only
	name?: string;
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
				const topic = args[0];
				if (topic === "alerts") return helpAlerts();
				if (topic === "beats") return helpBeats();
				if (topic === "bus") return helpBus();
				if (topic === "fav") return helpFav();
				if (topic === "info") return helpInfo();
				if (topic === "stats") return helpStats();
				if (topic === "admin" && isAdmin(ctx.pubKey)) return helpAdmin();
				return help(ctx.isDM);
			}
			case "info":
				return info();
			case "bus":
			case "alerts": {
				if (!args.length) return command === "bus" ? helpBus() : helpAlerts();
				const [stopId, ...routeWords] = args;
				const routeId = routeWords.join(" ");
				if (command === "bus") return routeId ? busStopAndRoute(stopId, routeId) : busStop(stopId);
				return routeId ? alertsStopAndRoute(stopId, routeId) : alertsStop(stopId);
			}
			case "fav":
			case "favs":
			case "favorites":
				return ctx.isDM ? fav(ctx.pubKey, args) : undefined;
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
