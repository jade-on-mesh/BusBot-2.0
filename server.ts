// Radio-less mode: BusBot answers commands over a local HTTP API, so another
// bot that already owns a radio (e.g. meshcore-bot via a local plugin) can
// forward bus/alerts/fav messages here and send back the reply.
//
//   POST /command  {"text": "bus 1120", "isDM": false, "name": "Jade", "pubKey": "a1b2c3..."}
//   ->             {"reply": "...", "parts": ["...", "..."]}   (reply null = not a BusBot command)
//   GET  /health   -> {"ok": true, ...}
//
// Listens on 127.0.0.1 only. Start with: npm run serve
import { warmPlanner } from "./planner";
import { createServer, IncomingMessage } from "node:http";
import { feeds, loadGtfs, soonestFeedEnd } from "./gtfs";
import { liveSummary } from "./realtime";
import { claimOutbox, startAlarms } from "./alarms";
import { nextBroadcastParts } from "./broadcast";
import { countQuery, divideReply, handleCommand } from "./router";
import { flushUsers, isBlocked, saveUsers, toHex, userPlace, users, validPlace } from "./store";

const HOST = process.env.BUSBOT_HOST || "127.0.0.1";
const PORT = parseInt(process.env.BUSBOT_PORT || "8787");
const MAX_BODY = 4096;

loadGtfs();
warmPlanner();

// Without its own radio, BusBot never hears adverts, so riders are created
// the first time they DM a command (needed for favorites).
const ensureUser = (pubKey: string, name?: string) => {
	const key = toHex(pubKey);
	const existing = users.get(key);
	if (existing) {
		existing.lastActive = Date.now();
		if (name) existing.advName = name;
		saveUsers();
		return;
	}
	users.set(key, {
		pubKey: key,
		advName: name ?? "",
		favoriteStops: [],
		firstSeen: Date.now(),
		lastSeen: Date.now(),
		lastActive: Date.now(),
		type: 1,
		flags: 0,
		outPathLen: -1,
		outPath: "",
		lastAdvert: 0,
		advLat: 0,
		advLon: 0,
	});
	saveUsers();
};

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});

const server = createServer(async (req, res) => {
	const send = (status: number, data: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};
	try {
		if (req.method === "GET" && req.url === "/health") {
			const soonest = soonestFeedEnd();
			return send(200, {
				ok: true,
				agencies: [...feeds.keys()],
				feedEndDate: soonest?.end ?? null,
				feedEndAgency: soonest?.agency ?? null,
				users: users.size,
				live: liveSummary(),
			});
		}
		// Ride-alarm DMs waiting to be sent. Each is handed out once; the
		// meshcore-bot service plugin collects them and sends with send_dm.
		if (req.method === "POST" && req.url === "/outbox/claim") {
			return send(200, { messages: claimOutbox() });
		}
		// The caller's channel has been quiet: is there an alert worth posting?
		// Returns {text: null} when not (none new, quiet hours, or disabled).
		// A long alert comes as two messages in "parts" ("text" has them on
		// separate lines, for older plugins).
		if (req.method === "POST" && req.url === "/broadcast/next") {
			const parts = await nextBroadcastParts();
			return send(200, { text: parts?.join("\n") ?? null, parts: parts ?? [] });
		}
		if (req.method !== "POST" || req.url !== "/command") return send(404, { error: "not found" });

		const { text, isDM = false, name, pubKey, words, lat, lon } = JSON.parse(await readBody(req)) as {
			text?: string;
			isDM?: boolean;
			name?: string;
			pubKey?: string;
			words?: Record<string, string>;
			lat?: number;
			lon?: number;
		};
		// canonical command -> the word riders type through the caller (for help text)
		const say =
			words && typeof words === "object"
				? Object.fromEntries(
						Object.entries(words).filter(([k, v]) => typeof k === "string" && typeof v === "string" && v.length <= 20),
					)
				: undefined;
		if (typeof text !== "string") return send(400, { error: "text required" });
		const key = typeof pubKey === "string" && /^[0-9a-fA-F]{6,64}$/.test(pubKey) ? pubKey.toLowerCase() : undefined;

		if (isBlocked({ name, pubKey: key })) return send(200, { reply: null, parts: [], blocked: true });
		if (isDM && key) ensureUser(key, name);

		// Rider position: sent by the caller, else the last one we stored for them.
		const near = validPlace(lat, lon) ?? (key ? userPlace(key) : undefined);
		const reply = await handleCommand(text, { isDM: Boolean(isDM), pubKey: key, name, say, near });
		if (!reply) return send(200, { reply: null, parts: [] });
		countQuery();
		return send(200, { reply, parts: divideReply(reply) });
	} catch (e) {
		console.error("Request error:", e);
		return send(400, { error: (e as Error).message });
	}
});

server.listen(PORT, HOST, () => console.log(`BusBot API listening on http://${HOST}:${PORT}`));
startAlarms(); // queue alarm DMs for /outbox/claim

const shutdown = () => {
	flushUsers();
	server.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
