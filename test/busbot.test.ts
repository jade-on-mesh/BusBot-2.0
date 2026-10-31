import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Env must be set before the modules load.
const dbDir = mkdtempSync(path.join(tmpdir(), "busbot-db-"));
process.env.GTFS_JSON_DIR = path.join(import.meta.dirname, "fixtures/json");
process.env.DB_DIR = dbDir;
process.env.METRO_GTFS_RT_TRIP_UPDATES_FEED = "https://example.test/trips.json";
process.env.METRO_GTFS_RT_SERVICE_ALERTS_FEED = "https://example.test/alerts.json";
process.env.LANGUAGE_CODE = "en";
process.env.ADMIN_KEYS = "aabbccddeeff";
process.env.OBA_API_KEY = "";
process.env.EMOJI = "off"; // most tests check plain text; emoji tests switch it on

const t = (iso: string) => new Date(iso).valueOf();
// Tue 27 Oct 2026, 08:10 Pacific (PDT, UTC-7)
const TUE_0810 = t("2026-10-27T15:10:00Z");
const TUE_0030 = t("2026-10-27T07:30:00Z");
// Thanksgiving, Thu 26 Nov 2026, 08:10 Pacific (PST, UTC-8)
const THANKSGIVING_0810 = t("2026-11-26T16:10:00Z");

const tripFeed = {
	entity: [
		{
			id: "1",
			trip_update: {
				trip: { trip_id: "T_LATE", route_id: "100011" },
				// delay reported at an earlier stop (seq 4) must propagate to seq 9
				stop_time_update: [{ stop_sequence: 4, stop_id: "11040", arrival: { delay: 900 } }],
			},
		},
		{
			id: "2",
			trip_update: { trip: { trip_id: "T_CANCEL", schedule_relationship: "CANCELED" } },
		},
	],
};
const alertFeed = {
	entity: [
		{
			id: "a1",
			alert: {
				// no "en" translation: original code crashed on this
				short_header_text: { translation: [{ text: "Ruta 11 desviada", language: "es" }] },
				informed_entity: [{ route_id: "100011" }], // route-wide, no stop_id
			},
		},
		{
			id: "a2",
			alert: {
				header_text: { translation: [{ text: "Old alert", language: "en" }] },
				active_period: [{ start: 1, end: 2 }],
				informed_entity: [{ stop_id: "1120" }],
			},
		},
	],
};
globalThis.fetch = (async (url: string) => {
	const body = String(url).includes("alerts") ? alertFeed : tripFeed;
	return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const gtfs = await import("../gtfs");
gtfs.loadGtfs();
const { busStop, busStopAndRoute } = await import("../commands/bus");
const { alertsStop, alertsStopAndRoute } = await import("../commands/alerts");
const { handleCommand, divideReply } = await import("../router");
const { parseCsvLine } = await import("../scripts/convert_txt");
const { parseGtfsDate, serviceDays } = await import("../time");
const store = await import("../store");

after(() => rmSync(dbDir, { recursive: true, force: true }));

describe("CSV conversion", () => {
	it("handles quoted commas and escaped quotes", () => {
		assert.deepEqual(parseCsvLine('1,"a, b","say ""hi""",'), ["1", "a, b", 'say "hi"', ""]);
		assert.equal(parseCsvLine('1,"open'), null);
	});
	it("kept the stop whose name contains a comma (and stripped the BOM)", () => {
		assert.equal(gtfs.findStop("1120")?.stop_name, "3rd Ave & Pike St, Bay 2");
	});
});

describe("time", () => {
	it("parses GTFS dates (new Date('20261110') is invalid)", () => {
		assert.equal(parseGtfsDate("20261110")?.toISOString(), "2026-11-10T00:00:00.000Z");
		assert.equal(parseGtfsDate("nope"), undefined);
	});
	it("computes service days in Pacific time regardless of host TZ", () => {
		const [today, yesterday] = serviceDays(TUE_0030);
		assert.equal(today.date, "20261027");
		assert.equal(today.weekday, "tuesday");
		assert.equal(yesterday.date, "20261026");
	});
});

describe("bus", () => {
	it("shows a late bus whose scheduled time has passed, and skips cancelled/inactive trips", async () => {
		const reply = await busStop("1120", TUE_0810);
		assert.equal(reply, "3rd Ave & Pike St, Bay 2\nG Line - 3 mins (s)\n11 - 5 mins");
	});
	it("lists upcoming trips for one route", async () => {
		assert.equal(
			await busStopAndRoute("1120", "11", TUE_0810),
			"11 @ 3rd Ave & Pike St, Bay 2\n5 mins\n10 mins (s)",
		);
	});
	it("finds routes by multi-word name", async () => {
		assert.match(await busStopAndRoute("1120", "g line", TUE_0810), /G Line @ 3rd Ave & Pike St, Bay 2\n3 mins \(s\)/);
	});
	it("includes after-midnight trips from yesterday's service (24:40:00)", async () => {
		assert.equal(await busStop("1120", TUE_0030), "3rd Ave & Pike St, Bay 2\n11 - 10 mins (s)");
	});
	it("honors calendar_dates holiday exceptions", async () => {
		assert.equal(
			await busStop("1120", THANKSGIVING_0810),
			"3rd Ave & Pike St, Bay 2\n11 - 4 mins (s)",
		);
	});
	it("handles unknown stops and routes", async () => {
		assert.equal(await busStop("999999", TUE_0810), "No stop found with that id.");
		assert.equal(await busStopAndRoute("1120", "999", TUE_0810), "No route found with that id.");
	});
});

describe("alerts", () => {
	it("matches route-wide alerts, falls back to another language, drops expired alerts", async () => {
		assert.equal(await alertsStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nRuta 11 desviada");
	});
	it("includes the stop header when filtering by route", async () => {
		assert.equal(
			await alertsStopAndRoute("1120", "g line", TUE_0810),
			"G Line @ 3rd Ave & Pike St, Bay 2\nNo alerts.",
		);
	});
});

describe("router", () => {
	it("ignores chatter that merely starts with a command word", async () => {
		for (const msg of ["busy day", "information please", "pinging", "helpful"]) {
			assert.equal(await handleCommand(msg, { isDM: false }), undefined, msg);
		}
	});
	it("answers commands", async () => {
		assert.equal(await handleCommand("ping", { isDM: false }), "pong!");
		assert.match((await handleCommand("bus", { isDM: false }))!, /^Use bus/);
		assert.match((await handleCommand("  BUS 1120 G Line ", { isDM: false }))!, /G Line/);
	});
	it("keeps fav and admin commands out of the channel", async () => {
		assert.equal(await handleCommand("fav", { isDM: false }), undefined);
		assert.equal(await handleCommand("blocklist", { isDM: true, pubKey: "1234567890ab" }), undefined);
	});
	it("splits long replies into parts under the limit without losing text", () => {
		const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") + " " + "x".repeat(300);
		const parts = divideReply(long);
		assert.ok(parts.every((p) => p.length <= 115), parts.map((p) => p.length).join(","));
		assert.equal(parts.join("").replace(/\s/g, ""), long.replace(/\s/g, ""));
		assert.deepEqual(divideReply("short"), ["short"]);
	});
});

describe("blocklist (issue #2)", () => {
	const adminKey = "aabbccddeeff" + "00".repeat(26);
	it("lets admins block and unblock by name and key prefix", async () => {
		const dm = { isDM: true, pubKey: adminKey };
		assert.equal(await handleCommand("block name Spammy McSpam", dm), "Blocked name: spammy mcspam");
		assert.equal(store.isBlocked({ name: "Spammy McSpam" }), true);
		assert.equal(await handleCommand("block key deadbeef", dm), "Blocked key: deadbeef");
		assert.equal(store.isBlocked({ pubKey: "deadbeef" + "11".repeat(28) }), true);
		assert.equal(store.isBlocked({ pubKey: "11".repeat(32) }), false);
		assert.equal(await handleCommand("unblock name spammy mcspam", dm), "Unblocked name: spammy mcspam");
		assert.equal(store.isBlocked({ name: "Spammy McSpam" }), false);
		assert.equal(await handleCommand("block key zz", dm), "Key must be at least 6 hex characters.");
	});
});

describe("favorites (issue #3)", () => {
	const key = "cc".repeat(32);
	before(() => {
		store.users.set(key, {
			pubKey: key,
			advName: "Rider",
			favoriteStops: [],
			firstSeen: 0,
			lastSeen: 0,
			type: 1,
			flags: 0,
			outPathLen: -1,
			outPath: "",
			lastAdvert: 0,
			advLat: 0,
			advLon: 0,
		});
	});
	it("adds, lists, and removes favorite stops", async () => {
		const dm = { isDM: true, pubKey: key };
		assert.equal(await handleCommand("fav", dm), "No favorites yet. Add one with: fav add [stop]");
		assert.equal(await handleCommand("fav add 1120", dm), "Saved 3rd Ave & Pike St, Bay 2 (1120).");
		assert.equal(await handleCommand("fav add 404404", dm), "No stop found with that id.");
		assert.match((await handleCommand("fav list", dm))!, /1120 3rd Ave/);
		assert.match((await handleCommand("fav", dm))!, /^3rd Ave & Pike St, Bay 2\n/);
		assert.equal(await handleCommand("fav rm 1120", dm), "Removed 1120.");
	});
	it("persists users to disk", () => {
		store.flushUsers();
		assert.ok(store.users.has(key));
	});
});

describe("OneBusAway (issue #1)", () => {
	const realFetch = globalThis.fetch;
	after(() => {
		process.env.OBA_API_KEY = "";
		globalThis.fetch = realFetch;
	});
	it("uses OBA predictions when a key is set", async () => {
		process.env.OBA_API_KEY = "test-key";
		let requested = "";
		globalThis.fetch = (async (url: string) => {
			requested = String(url);
			return new Response(
				JSON.stringify({
					code: 200,
					data: {
						entry: {
							arrivalsAndDepartures: [
								{ routeShortName: "11", routeId: "1_100011", predicted: true, predictedArrivalTime: TUE_0810 + 7 * 60_000, scheduledArrivalTime: TUE_0810 + 5 * 60_000 },
								{ routeShortName: "G Line", routeId: "1_102745", predicted: false, predictedArrivalTime: 0, scheduledArrivalTime: TUE_0810 + 2 * 60_000 },
							],
						},
						references: { situations: [{ summary: { value: "Elevator out at Pike" } }] },
					},
				}),
			);
		}) as typeof fetch;
		assert.equal(await busStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nG Line - 2 mins (s)\n11 - 7 mins");
		assert.match(requested, /arrivals-and-departures-for-stop\/1_1120\.json\?key=test-key/);
		assert.equal(await alertsStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nElevator out at Pike");
	});
	it("falls back to GTFS when OBA fails", async () => {
		process.env.OBA_API_KEY = "test-key";
		globalThis.fetch = (async (url: string) => {
			if (String(url).includes("onebusaway")) return new Response("nope", { status: 503 });
			return realFetch(url);
		}) as typeof fetch;
		assert.equal(await busStopAndRoute("11040", "11", TUE_0810 - 25 * 60_000), "11 @ Broadway & E Pine St\n20 mins");
	});
});

describe("emoji", () => {
	before(() => (process.env.EMOJI = "on"));
	after(() => (process.env.EMOJI = "off"));
	it("decorates arrivals: stop pin, RapidRide red dot, bus, clock for scheduled", async () => {
		assert.equal(
			await busStop("1120", TUE_0810),
			"🚏 3rd Ave & Pike St, Bay 2\n🔴 G Line - 3 mins 🕒\n🚌 11 - 5 mins",
		);
		assert.equal(await busStop("999999", TUE_0810), "❓ No stop found with that id.");
	});
	it("decorates alerts and the all-clear", async () => {
		assert.equal(await alertsStop("1120", TUE_0810), "🚏 3rd Ave & Pike St, Bay 2\n⚠️ Ruta 11 desviada");
		assert.match(await alertsStopAndRoute("1120", "g line", TUE_0810), /✅ No alerts\.$/);
	});
	it("keeps every split part within the byte limit and never splits an emoji", () => {
		const reply = Array.from({ length: 12 }, (_, i) => `🚌 Route ${i} - ${i} mins 🕒`).join("\n");
		const parts = divideReply(reply);
		assert.ok(parts.length > 1);
		for (const p of parts) assert.ok(Buffer.byteLength(p) <= 115, `${Buffer.byteLength(p)} bytes: ${p}`);
		assert.equal(parts.join(" ").replace(/\s+/g, " "), reply.replace(/\s+/g, " "));
		const emojiWall = "🚌".repeat(60);
		for (const p of divideReply(emojiWall)) assert.match(p, /^(🚌)+$/u);
	});
});
