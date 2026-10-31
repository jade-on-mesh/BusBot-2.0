// Emoji styling for replies. Set EMOJI=off in .env for plain text, e.g. if
// riders on standalone radios see boxes instead of emoji.
//
// Every emoji is 4 bytes on the air, so they're kept to one per line.
import type { Route } from "./gtfs";

export const emojiOn = () => !/^(0|false|off|no)$/i.test((process.env.EMOJI ?? "").trim());

// Prefix a line with an emoji (or nothing, when emoji are off).
export const em = (emoji: string, text: string) => (emojiOn() ? `${emoji} ${text}` : text);

// Marker for a time that comes from the schedule rather than live tracking.
export const scheduledMark = () => (emojiOn() ? " 🕒" : " (s)");

// GTFS route_type: 0 tram/streetcar, 1 subway, 2 rail, 3 bus, 4 ferry.
// King County Metro's RapidRide lines are buses named "A Line" .. "K Line".
export const routeEmoji = (route?: Pick<Route, "route_short_name" | "route_type">, name = "") => {
	const shortName = route?.route_short_name || name;
	switch (String(route?.route_type ?? "3")) {
		case "0":
			return "🚋";
		case "1":
		case "2":
		case "12":
			return "🚆";
		case "4":
			return "⛴️";
		default:
			return /^[A-Z] Line$/i.test(shortName) ? "🔴" : "🚌";
	}
};
