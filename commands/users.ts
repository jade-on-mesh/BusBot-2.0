// Favorite stops (issue #3) and admin blocklist commands (issue #2).
import { parseStopArgs, Place, resolveStop, stopFromKey, stopRef } from "../gtfs";
import { blocklist, findUserByPrefix, flushUsers, MAX_FAVORITES, saveBlocklist, users } from "../store";
import { em } from "../style";
import { busStop } from "./bus";

export const fav = async (pubKey: string | undefined, args: string[], near?: Place) => {
	if (!pubKey) return "Favorites work in direct messages only.";
	const user = users.get(pubKey) ?? findUserByPrefix(pubKey);
	if (!user) return "I haven't heard your advert yet. Send an advert, then try again.";

	// Favorites are stored as stop keys ("kcm:1120", "ct:1120"); entries saved
	// before multi-agency support are bare ids, read as the default agency.
	const [action, ...rest] = args;
	const keyOf = (stored: string) => stopFromKey(stored)?.key ?? stored;
	if (action === "add" || action === "rm" || action === "remove" || action === "del") {
		const { agency, stop: typed } = parseStopArgs(rest);
		if (!typed) return `Use: fav ${action} [stop]`;
		const found = resolveStop(typed, { agency, near });
		if (action === "add") {
			if (!found) return em("❓", "No stop found with that id.");
			const { stop } = found;
			if (user.favoriteStops.some((s) => keyOf(s) === stop.key)) {
				return em("⭐", `${stop.stop_name} is already a favorite.`);
			}
			if (user.favoriteStops.length >= MAX_FAVORITES) {
				return `You can save up to ${MAX_FAVORITES} stops. Remove one with: fav rm [stop]`;
			}
			user.favoriteStops.push(stop.key);
			flushUsers(); // rider-initiated and rare: write now, not on the batch timer
			return em("⭐", `Saved ${stop.stop_name} (${stopRef(stop)}).`);
		}
		// Remove: match any agency's stop with that number the rider has saved.
		const before = user.favoriteStops.length;
		const wanted = new Set(
			[found?.stop, ...(found?.others ?? [])].filter((s) => s && (!agency || s.agency === agency)).map((s) => s!.key),
		);
		const removed = user.favoriteStops.filter((s) => wanted.has(keyOf(s)));
		user.favoriteStops = user.favoriteStops.filter((s) => !wanted.has(keyOf(s)));
		if (user.favoriteStops.length === before) return "That stop isn't in your favorites.";
		flushUsers();
		return em("🗑️", `Removed ${removed.map((k) => { const s = stopFromKey(k); return s ? stopRef(s) : k; }).join(", ")}.`);
	}
	if (action === "list") {
		if (!user.favoriteStops.length) return em("⭐", "No favorites yet. Add one with: fav add [stop]");
		return `${em("⭐", "Favorites:")}\n${user.favoriteStops
			.map((s) => {
				const stop = stopFromKey(s);
				return stop ? `${stopRef(stop)} ${stop.stop_name}` : `${s} (unknown stop)`;
			})
			.join("\n")}`;
	}
	if (action) return "Use: fav, fav add [stop], fav rm [stop], fav list";

	if (!user.favoriteStops.length) return em("⭐", "No favorites yet. Add one with: fav add [stop]");
	const replies = await Promise.all(
		user.favoriteStops.map((s) => {
			const stop = stopFromKey(s);
			return stop ? busStop(stop.stop_id, Date.now(), { agency: stop.agency }) : `${s} (unknown stop)`;
		}),
	);
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
