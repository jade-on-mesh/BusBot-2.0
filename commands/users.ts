// Favorite stops (issue #3) and admin blocklist commands (issue #2).
import { findStop } from "../gtfs";
import { blocklist, findUserByPrefix, flushUsers, MAX_FAVORITES, saveBlocklist, users } from "../store";
import { em } from "../style";
import { busStop } from "./bus";

export const fav = async (pubKey: string | undefined, args: string[]) => {
	if (!pubKey) return "Favorites work in direct messages only.";
	const user = users.get(pubKey) ?? findUserByPrefix(pubKey);
	if (!user) return "I haven't heard your advert yet. Send an advert, then try again.";

	const [action, stopId] = args;
	if (action === "add") {
		if (!stopId) return "Use: fav add [stop]";
		const stop = findStop(stopId);
		if (!stop) return em("❓", "No stop found with that id.");
		if (user.favoriteStops.includes(stopId)) return em("⭐", `${stop.stop_name} is already a favorite.`);
		if (user.favoriteStops.length >= MAX_FAVORITES) {
			return `You can save up to ${MAX_FAVORITES} stops. Remove one with: fav rm [stop]`;
		}
		user.favoriteStops.push(stopId);
		flushUsers(); // rider-initiated and rare: write now, not on the batch timer
		return em("⭐", `Saved ${stop.stop_name} (${stopId}).`);
	}
	if (action === "rm" || action === "remove" || action === "del") {
		if (!stopId) return "Use: fav rm [stop]";
		const before = user.favoriteStops.length;
		user.favoriteStops = user.favoriteStops.filter((s) => s !== stopId);
		if (user.favoriteStops.length === before) return "That stop isn't in your favorites.";
		flushUsers(); // rider-initiated and rare: write now, not on the batch timer
		return em("🗑️", `Removed ${stopId}.`);
	}
	if (action === "list") {
		if (!user.favoriteStops.length) return em("⭐", "No favorites yet. Add one with: fav add [stop]");
		return `${em("⭐", "Favorites:")}\n${user.favoriteStops
			.map((s) => `${s} ${findStop(s)?.stop_name ?? "(unknown stop)"}`)
			.join("\n")}`;
	}
	if (action) return "Use: fav, fav add [stop], fav rm [stop], fav list";

	if (!user.favoriteStops.length) return em("⭐", "No favorites yet. Add one with: fav add [stop]");
	const replies = await Promise.all(user.favoriteStops.map((s) => busStop(s)));
	return replies.join("\n");
};

export const admin = (command: string, args: string[]) => {
	if (command === "blocklist") {
		const names = blocklist.names.length ? blocklist.names.join(", ") : "none";
		const keys = blocklist.keys.length ? blocklist.keys.join(", ") : "none";
		return `Blocked names: ${names}\nBlocked keys: ${keys}`;
	}
	const [kind, ...rest] = args;
	const value = rest.join(" ").trim().toLowerCase();
	if ((kind !== "name" && kind !== "key") || !value) {
		return `Use: ${command} name [name] or ${command} key [hex prefix]`;
	}
	if (kind === "key" && !/^[0-9a-f]{6,64}$/.test(value)) {
		return "Key must be at least 6 hex characters.";
	}
	const list = kind === "name" ? blocklist.names : blocklist.keys;
	if (command === "block") {
		if (list.includes(value)) return `Already blocked: ${value}`;
		list.push(value);
		saveBlocklist();
		return em("🚫", `Blocked ${kind}: ${value}`);
	}
	const idx = list.indexOf(value);
	if (idx === -1) return `Not blocked: ${value}`;
	list.splice(idx, 1);
	saveBlocklist();
	return em("✅", `Unblocked ${kind}: ${value}`);
};
