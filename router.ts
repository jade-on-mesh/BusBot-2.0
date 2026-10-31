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
// 150 (max channel message) - 32 (max name) - 3 (": " etc.)
export const MAX_LENGTH = 115;
export const divideReply = (message: string, maxLength = MAX_LENGTH) => {
	let messageCount = 1;
	let targetLength = message.length;
	while (targetLength > maxLength) {
		messageCount++;
		targetLength = Math.ceil(message.length / messageCount);
	}
	if (messageCount === 1) return [message];

	const segmenter = new Intl.Segmenter(process.env.LANGUAGE_CODE ?? "en", { granularity: "word" });
	const replies: string[] = [];
	let current = "";
	const push = () => {
		if (current.trim()) replies.push(current.trim());
		current = "";
	};
	for (const { segment } of segmenter.segment(message)) {
		if (current.length && current.length + segment.length > targetLength) push();
		// Hard-split any single segment that's longer than the limit.
		let seg = segment;
		while (seg.length > maxLength) {
			push();
			replies.push(seg.slice(0, maxLength));
			seg = seg.slice(maxLength);
		}
		current += seg;
		if (current.length > maxLength) {
			const overflow = current.slice(maxLength);
			current = current.slice(0, maxLength);
			push();
			current = overflow;
		}
	}
	push();
	return replies;
};
