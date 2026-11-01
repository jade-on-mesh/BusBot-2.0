import { warmPlanner } from "./planner";
import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { info } from "./commands";
import { OutgoingDm, startAlarms } from "./alarms";
import { broadcastsEnabled, nextBroadcastParts, quietMinutes } from "./broadcast";
import { agencyName, loadGtfs, soonestFeedEnd } from "./gtfs";
import { countQuery, divideReply, handleCommand } from "./router";
import {
	findUserByPrefix,
	flushUsers,
	fromHex,
	isAdmin,
	isBlocked,
	saveState,
	saveUsers,
	state,
	toHex,
	User,
	userPlace,
	users,
} from "./store";
import { em } from "./style";
import { parseGtfsDate } from "./time";

// ---------- config ----------

const requireEnv = (name: string) => {
	const v = process.env[name];
	if (!v) throw new Error(`Missing ${name} in .env`);
	return v;
};
const SERIAL_PORT = requireEnv("SERIAL_PORT");
const NODE_NAME = requireEnv("NODE_NAME");
const BOT_CHANNEL = requireEnv("BOT_CHANNEL");
const MAX_CONTACTS = parseInt(process.env.MAX_CONTACTS || "90"); // leave headroom below the radio's limit
const SEND_SPACING_MS = parseInt(process.env.SEND_SPACING_MS || "2000");
const ADVERT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

const COMPANION = 1; // contact type for chat nodes

loadGtfs();
warmPlanner();

const connection = new NodeJSSerialConnection(SERIAL_PORT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- radio queue ----------
// meshcore.js matches replies to commands by response code (Ok/Err), so two
// commands in flight at once can resolve each other's promises. Every radio
// operation goes through this one queue. It also spaces outgoing messages so
// multi-part replies arrive in order and don't flood the mesh. (The original
// wrapped setTimeout in Promise.all, which awaited nothing and let send errors
// become unhandled rejections.)
const RADIO_TIMEOUT_MS = 20_000;
let radioQueue: Promise<unknown> = Promise.resolve();
const withRadio = <T = any>(fn: () => Promise<T> | T, label = "radio op"): Promise<T | undefined> => {
	// A command the radio never answers must not wedge the queue forever.
	const timed = () =>
		Promise.race([
			Promise.resolve().then(fn),
			sleep(RADIO_TIMEOUT_MS).then(() => {
				throw new Error(`timed out after ${RADIO_TIMEOUT_MS / 1000}s`);
			}),
		]);
	const run = radioQueue.then(timed).catch((e) => {
		console.error(`Error during ${label}:`, e);
		return undefined;
	});
	radioQueue = run;
	return run;
};

const sendReplies = async (parts: string[], send: (part: string) => Promise<unknown>, label: string) => {
	for (const part of parts) {
		await withRadio(async () => {
			await send(part);
			await sleep(SEND_SPACING_MS);
		}, label);
	}
};

// ---------- channel ----------

let botChannelIdx: number | undefined;
const getBotChannelIdx = async () => {
	if (botChannelIdx !== undefined) return botChannelIdx;
	const channel = await withRadio(() => connection.findChannelByName(BOT_CHANNEL), "find channel");
	if (!channel) {
		console.error(`Channel ${BOT_CHANNEL} not found on the radio. Add it in the companion app.`);
		return undefined;
	}
	botChannelIdx = channel.channelIdx;
	return botChannelIdx;
};

// Last time anyone (including the bot) said anything on the bot channel.
// Starts at boot so a restart doesn't trigger an immediate alert post.
let lastChannelActivity = Date.now();

const sendToChannel = async (text: string) => {
	const idx = await getBotChannelIdx();
	if (idx === undefined) return;
	lastChannelActivity = Date.now();
	await sendReplies(divideReply(text), (p) => connection.sendChannelTextMessage(idx, p), "channel send");
};

// ---------- advert + feed expiry ----------

const checkToAdvertAndInfo = async () => {
	const now = Date.now();
	if (state.lastAdvert && now - state.lastAdvert < ADVERT_INTERVAL_MS) return;
	state.lastAdvert = now;
	saveState();

	console.log("Sending advert");
	await withRadio(() => connection.sendFloodAdvert(), "flood advert");
	await sleep(5000);
	await sendToChannel(info());

	const soonest = soonestFeedEnd();
	const end = soonest ? parseGtfsDate(soonest.end) : undefined;
	if (soonest && end && now > end.valueOf() - FEED_WARNING_MS) {
		const who = agencyName(soonest.agency);
		const expired = now > end.valueOf() + 24 * 60 * 60 * 1000;
		const msg = expired
			? em("⚠️", `${who} schedule data has expired. Times may be wrong until the operator runs npm run feeds.`)
			: em("⚠️", `${who} schedule data expires soon. The operator needs to run npm run feeds.`);
		console.warn(msg, soonest.end);
		await sendToChannel(msg);
	}
};

// ---------- users & contacts (issue #3) ----------

const userFromAdvert = (advert: any, existing?: User): User => ({
	pubKey: toHex(advert.publicKey),
	advName: advert.advName,
	favoriteStops: existing?.favoriteStops ?? [],
	firstSeen: existing?.firstSeen ?? Date.now(),
	lastSeen: Date.now(),
	lastActive: existing?.lastActive,
	type: advert.type,
	flags: advert.flags,
	outPathLen: advert.outPathLen,
	outPath: toHex(advert.outPath),
	lastAdvert: advert.lastAdvert,
	advLat: advert.advLat,
	advLon: advert.advLon,
});

// Least recently active first (DM'd the bot), then least recently heard.
const evictionScore = (pubKey: string) => {
	const u = users.get(pubKey);
	return Math.max(u?.lastActive ?? 0, (u?.lastSeen ?? 0) - 30 * 24 * 60 * 60 * 1000);
};

// The radio only holds so many contacts, and it can only decrypt DMs from
// contacts it holds. BusBot keeps every user on disk and treats the radio's
// contact table as a cache: when it's full, the least recently active
// companion is removed to make room. Their favorites stay on disk, and their
// next advert puts them back.
const ensureContactOnRadio = async (user: User) => {
	await withRadio(async () => {
		const contacts: any[] = await connection.getContacts();
		const key = user.pubKey;
		const onRadio = contacts.some((c) => toHex(c.publicKey) === key);
		const companions = contacts.filter((c) => c.type === COMPANION);

		if (!onRadio && companions.length >= MAX_CONTACTS) {
			const victims = companions
				.map((c) => toHex(c.publicKey))
				.filter((k) => !isAdmin(k))
				.sort((a, b) => evictionScore(a) - evictionScore(b));
			const victim = victims[0];
			if (!victim) {
				console.log("Contact table full of admins; not adding", user.advName);
				return;
			}
			console.log("Contact table full, evicting", users.get(victim)?.advName ?? victim.slice(0, 12));
			await connection.removeContact(fromHex(victim));
		}

		await connection.addOrUpdateContact(
			fromHex(user.pubKey),
			user.type,
			user.flags,
			user.outPathLen,
			fromHex(user.outPath),
			user.advName,
			user.lastAdvert,
			user.advLat,
			user.advLon,
		);
	}, "add contact");
};

// Import contacts already on the radio so existing users aren't evicted first.
const syncContactsToStore = async () => {
	const contacts = await withRadio(() => connection.getContacts(), "get contacts");
	for (const c of contacts ?? []) {
		if (c.type !== COMPANION) continue;
		const key = toHex(c.publicKey);
		if (!users.has(key)) users.set(key, { ...userFromAdvert(c), lastSeen: (c.lastAdvert ?? 0) * 1000 });
	}
	flushUsers();
};

// ---------- incoming messages ----------

const handleContactMessage = async (message: any) => {
	const contact = await withRadio(
		() => connection.findContactByPublicKeyPrefix(message.pubKeyPrefix),
		"find contact",
	);
	const pubKey = contact ? toHex(contact.publicKey) : findUserByPrefix(message.pubKeyPrefix)?.pubKey;
	if (!contact) {
		console.log("DM from unknown contact", toHex(message.pubKeyPrefix));
		return;
	}
	const name = contact.advName;
	if (isBlocked({ name, pubKey })) {
		console.log("Ignoring blocked DM from", name);
		return;
	}
	const user = pubKey ? users.get(pubKey) : undefined;
	if (user) {
		user.lastActive = Date.now();
		saveUsers();
	}

	const reply = await handleCommand(message.text, { isDM: true, pubKey, name, near: pubKey ? userPlace(pubKey) : undefined });
	if (!reply) return;
	countQuery();
	await sendReplies(
		divideReply(reply),
		(p) => connection.sendTextMessage(contact.publicKey, p, Constants.TxtTypes.Plain),
		"DM send",
	);
};

const handleChannelMessage = async (message: any) => {
	const idx = await getBotChannelIdx();
	if (idx === undefined || message.channelIdx !== idx) return;
	lastChannelActivity = Date.now();

	// Channel text is "Sender Name: message"
	const text: string = message.text ?? "";
	const sep = text.indexOf(": ");
	const name = sep >= 0 ? text.slice(0, sep) : "";
	const body = sep >= 0 ? text.slice(sep + 2) : text;
	if (isBlocked({ name })) {
		console.log("Ignoring blocked channel message from", name);
		return;
	}

	const reply = await handleCommand(body, { isDM: false, name });
	if (!reply) return;
	countQuery();
	await sendToChannel(reply);
};

let drainingMessages = false;
const drainMessages = async () => {
	if (drainingMessages) return;
	drainingMessages = true;
	try {
		const waiting = (await withRadio(() => connection.getWaitingMessages(), "get messages")) ?? [];
		for (const message of waiting) {
			try {
				if (message.contactMessage) await handleContactMessage(message.contactMessage);
				else if (message.channelMessage) await handleChannelMessage(message.channelMessage);
			} catch (e) {
				console.error("Error handling message:", e);
			}
		}
	} finally {
		drainingMessages = false;
	}
};

// ---------- connection events ----------

// Ride alarms: send due DMs straight from the radio.
const deliverAlarm = async (dm: OutgoingDm) =>
	sendReplies(
		divideReply(dm.text),
		(p) => connection.sendTextMessage(fromHex(dm.pubKey), p, Constants.TxtTypes.Plain),
		"alarm DM",
	);

// Quiet-channel alert posts: after an hour of silence, share one active alert.
let alertPostTimer: NodeJS.Timeout | undefined;
const startAlertPosts = () => {
	if (alertPostTimer || !broadcastsEnabled()) return;
	alertPostTimer = setInterval(async () => {
		try {
			if (Date.now() - lastChannelActivity < quietMinutes() * 60_000) return;
			const parts = await nextBroadcastParts();
			for (const [i, part] of (parts ?? []).entries()) {
				if (i) await new Promise((r) => setTimeout(r, 8000)); // let the first part's flood clear
				await sendToChannel(part);
			}
		} catch (e) {
			console.error("Alert post failed:", e);
		}
	}, 5 * 60_000);
	alertPostTimer.unref();
};

connection.on("connected", async () => {
	console.log("Connected");
	try {
		await withRadio(() => connection.syncDeviceTime(), "sync time");
		await withRadio(() => connection.setAdvertName(NODE_NAME), "set name");
		await withRadio(() => connection.setManualAddContacts(), "manual add contacts");
		botChannelIdx = undefined;
		await getBotChannelIdx();
		await syncContactsToStore();
		await drainMessages(); // anything that arrived while we were offline
		startAlarms(deliverAlarm);
		startAlertPosts();
		await checkToAdvertAndInfo();
	} catch (e) {
		console.error("Error during startup:", e);
	}
});

connection.on(Constants.PushCodes.MsgWaiting, () => {
	drainMessages().catch((e) => console.error("Error draining messages:", e));
});

// Advert from a contact already on the radio: refresh last-heard time and
// drop any non-companion contacts (repeaters, rooms) the radio auto-added.
connection.on(Constants.PushCodes.Advert, async (advert: any) => {
	try {
		const user = users.get(toHex(advert.publicKey));
		if (user) {
			user.lastSeen = Date.now();
			saveUsers();
		}
		const contacts = (await withRadio(() => connection.getContacts(), "get contacts")) ?? [];
		for (const c of contacts.filter((c: any) => c.type !== COMPANION)) {
			console.log("Removing non-companion contact:", c.advName);
			await withRadio(() => connection.removeContact(c.publicKey), "remove contact");
		}
		await checkToAdvertAndInfo();
	} catch (e) {
		console.error("Error handling advert:", e);
	}
});

// Advert from someone not on the radio (manual-add mode).
connection.on(Constants.PushCodes.NewAdvert, async (advert: any) => {
	if (advert.type !== COMPANION) return;
	try {
		const key = toHex(advert.publicKey);
		if (isBlocked({ name: advert.advName, pubKey: key })) return;
		const user = userFromAdvert(advert, users.get(key));
		users.set(key, user);
		saveUsers();
		console.log("Companion advert:", user.advName);
		await ensureContactOnRadio(user);
		await checkToAdvertAndInfo();
	} catch (e) {
		console.error("Error adding or updating contact:", e);
	}
});

// Reconnect with backoff instead of hammering a missing serial port.
let reconnectDelay = 2000;
const connect = async () => {
	while (true) {
		try {
			await connection.connect();
			reconnectDelay = 2000;
			return;
		} catch (e) {
			console.error(`Connect failed, retrying in ${reconnectDelay / 1000}s:`, (e as Error).message);
			await sleep(reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
		}
	}
};

connection.on("disconnected", async () => {
	console.log("Disconnected");
	radioQueue = Promise.resolve(); // drop anything waiting on the dead link
	await sleep(reconnectDelay);
	await connect();
});

const shutdown = () => {
	console.log("Shutting down");
	flushUsers();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));

await connect();
