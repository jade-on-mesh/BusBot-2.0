// Small JSON-file persistence for bot state, users (issue #3) and the
// blocklist (issue #2). Writes go to a temp file then rename, so a power cut
// on the Pi can't leave a half-written file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DB_DIR = process.env.DB_DIR || "./db";

export const readJson = <T>(name: string, fallback: T): T => {
	try {
		const file = path.join(DB_DIR, name);
		if (!existsSync(file)) return fallback;
		return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
	} catch (e) {
		console.error(`Error reading ${name}:`, e);
		return fallback;
	}
};

export const writeJson = (name: string, data: unknown) => {
	try {
		mkdirSync(DB_DIR, { recursive: true });
		const file = path.join(DB_DIR, name);
		writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
		renameSync(`${file}.tmp`, file);
	} catch (e) {
		console.error(`Error writing ${name}:`, e);
	}
};

export const toHex = (bytes: Uint8Array | number[] | string) =>
	typeof bytes === "string" ? bytes.toLowerCase() : Buffer.from(bytes).toString("hex");
export const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

// ---------- state ----------

type State = { lastAdvert?: number };
// Reads the old misspelled key too: the original wrote `lastAvert` but read
// `lastAdvert`, so it flood-adverted on every restart.
const rawState = readJson<State & { lastAvert?: number }>("lastAdvert.json", {});
export const state: State = {
	lastAdvert: rawState.lastAdvert ?? rawState.lastAvert,
};
export const saveState = () => writeJson("lastAdvert.json", state);

// ---------- users (issue #3) ----------

export interface User {
	pubKey: string; // hex
	advName: string;
	favoriteStops: string[];
	firstSeen: number;
	lastSeen: number; // last advert
	lastActive?: number; // last DM to the bot
	// Advert fields so the contact can be re-added to the radio after eviction
	type: number;
	flags: number;
	outPathLen: number;
	outPath: string; // hex
	lastAdvert: number;
	advLat: number;
	advLon: number;
	// send stops as map pins with DM replies (pins on)
	mapPins?: boolean;
}

const usersFile = readJson<{ users: User[] }>("users.json", { users: [] });
export const users = new Map<string, User>(usersFile.users.map((u) => [u.pubKey, u]));
let usersDirty = false;
export const saveUsers = () => {
	usersDirty = true;
};
// Batch user writes: adverts arrive constantly on a busy mesh.
setInterval(() => {
	if (!usersDirty) return;
	usersDirty = false;
	writeJson("users.json", { users: [...users.values()] });
}, 10_000).unref();
export const flushUsers = () => {
	usersDirty = false;
	writeJson("users.json", { users: [...users.values()] });
};

export const findUserByPrefix = (prefix: Uint8Array | string) => {
	const p = toHex(prefix);
	for (const u of users.values()) if (u.pubKey.startsWith(p)) return u;
	return undefined;
};

export const MAX_FAVORITES = 5;

// A usable lat/lon, or undefined. 0,0 means "no position" in MeshCore adverts.
export const validPlace = (lat?: unknown, lon?: unknown) => {
	if (typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) || !isFinite(lon)) return undefined;
	if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
	return { lat, lon };
};

// Adverts carry position as integer microdegrees.
export const userPlace = (pubKey: string) => {
	const u = users.get(pubKey) ?? findUserByPrefix(pubKey);
	return u ? validPlace(u.advLat / 1e6, u.advLon / 1e6) : undefined;
};

// ---------- blocklist (issue #2) ----------

type Blocklist = { names: string[]; keys: string[] };
export const blocklist = readJson<Blocklist>("blocklist.json", { names: [], keys: [] });
export const saveBlocklist = () => writeJson("blocklist.json", blocklist);

const norm = (s: string) => s.trim().toLowerCase();

// Env-configured blocks are always applied in addition to the saved list.
const envList = (v?: string) =>
	(v ?? "")
		.split(",")
		.map(norm)
		.filter(Boolean);

export const isBlocked = ({ name, pubKey }: { name?: string; pubKey?: string }) => {
	const names = [...blocklist.names, ...envList(process.env.BLOCKED_NAMES)];
	const keys = [...blocklist.keys, ...envList(process.env.BLOCKED_KEYS)];
	if (name && names.includes(norm(name))) return true;
	if (pubKey) {
		const k = norm(pubKey);
		// a stored prefix blocks every key that starts with it
		if (keys.some((b) => b && (k.startsWith(b) || b.startsWith(k)))) return true;
	}
	return false;
};

export const isAdmin = (pubKey?: string) => {
	if (!pubKey) return false;
	const k = norm(pubKey);
	return envList(process.env.ADMIN_KEYS).some((a) => a.length >= 6 && k.startsWith(a));
};
