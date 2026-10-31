import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Env must be set before the modules load.
const dbDir = mkdtempSync(path.join(tmpdir(), "busbot-db-"));
process.env.FEEDS_FILE = path.join(import.meta.dirname, "fixtures/feeds.json");
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
		assert.equal(gtfs.resolveStop("1120")?.stop.stop_name, "3rd Ave & Pike St, Bay 2");
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
		assert.equal(reply, "3rd Ave & Pike St, Bay 2\nG Line - 3 mins (s)\n11 - 5 mins\nalso: ct 1120");
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
		assert.equal(await busStop("1120", TUE_0030), "3rd Ave & Pike St, Bay 2\n11 - 10 mins (s)\nalso: ct 1120");
	});
	it("honors calendar_dates holiday exceptions", async () => {
		assert.equal(
			await busStop("1120", THANKSGIVING_0810),
			"3rd Ave & Pike St, Bay 2\n11 - 4 mins (s)\nalso: ct 1120",
		);
	});
	it("handles unknown stops and routes", async () => {
		assert.equal(await busStop("999999", TUE_0810), "No stop found with that id.");
		assert.equal(await busStopAndRoute("1120", "999", TUE_0810), "No route found with that id.");
	});
});

describe("alerts", () => {
	it("matches route-wide alerts, falls back to another language, drops expired alerts", async () => {
		assert.equal(await alertsStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nRuta 11 desviada\nalso: ct 1120");
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
		assert.match((await handleCommand("bus", { isDM: false }))!, /^Next arrivals/);
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
		assert.equal(await busStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nG Line - 2 mins (s)\n11 - 7 mins\nalso: ct 1120");
		assert.match(requested, /arrivals-and-departures-for-stop\/1_1120\.json\?key=test-key/);
		assert.equal(await alertsStop("1120", TUE_0810), "3rd Ave & Pike St, Bay 2\nElevator out at Pike\nalso: ct 1120");
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
	it("decorates arrivals: stop pin, RapidRide oncoming bus, bus, clock for scheduled", async () => {
		assert.equal(
			await busStop("1120", TUE_0810),
			"🚏 3rd Ave & Pike St, Bay 2\n🚍 G Line - 3 mins 🕒\n🚌 11 - 5 mins\nalso: ct 1120",
		);
		assert.equal(await busStop("999999", TUE_0810), "❓ No stop found with that id.");
	});
	it("decorates alerts and the all-clear", async () => {
		assert.equal(await alertsStop("1120", TUE_0810), "🚏 3rd Ave & Pike St, Bay 2\n⚠️ Ruta 11 desviada\nalso: ct 1120");
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

describe("stops search", () => {
	const realFetch = globalThis.fetch;
	after(() => {
		globalThis.fetch = realFetch;
		process.env.GEOCODE = "";
	});
	it("finds stops by cross streets, any order, with abbreviations and ordinals", async () => {
		for (const q of ["pike 3rd", "third avenue and pike street", "3 pike", "PIKE & 3RD AVE"]) {
			assert.equal(
				await handleCommand(`stops ${q}`, { isDM: false }),
				`${q.toLowerCase()}:\n1120 3rd Ave & Pike St, Bay 2 → 11, G Line`,
				q,
			);
		}
		assert.match((await handleCommand("stops broadway east pine", { isDM: false }))!, /^broadway east pine:\n11040 Broadway & E Pine St → 11$/);
	});
	it("doesn't let one-letter directions match everything", async () => {
		process.env.GEOCODE = "off";
		assert.match((await handleCommand("stops e", { isDM: false }))!, /No stops match/);
	});
	it("falls back to geocoding and lists nearest stops with distance", async () => {
		process.env.GEOCODE = "on";
		let url = "";
		globalThis.fetch = (async (u: string) => {
			url = String(u);
			// a point ~110 m north of stop 11040
			return new Response(JSON.stringify([{ lat: "47.611", lon: "-122.32", name: "Somewhere on Broadway" }]));
		}) as typeof fetch;
		const reply = await handleCommand("stops 1100 broadway", { isDM: false });
		assert.match(url, /nominatim\.openstreetmap\.org\/search\?q=1100\+broadway.*bounded=1/);
		assert.match(reply!, /^Near Somewhere on Broadway:\n11040 Broadway & E Pine St · 350 ft → 11\n1120 3rd Ave & Pike St, Bay 2 · 1\.2 mi → 11, G Line$/);
	});
	it("says so when the place isn't in King County", async () => {
		process.env.GEOCODE = "on";
		globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
		assert.match((await handleCommand("stops zzzz nowhere", { isDM: false }))!, /Couldn't find that around Puget Sound/);
	});
});

describe("help", () => {
	it("lists commands standalone, with fav only in DMs", async () => {
		const ch = (await handleCommand("help", { isDM: false }))!;
		assert.match(ch, /^Transit:\nbus \[stop\] \[route\]\nstops \[streets\/address\]\nalerts \[stop\]\ninfo stats beats\nhelp \[cmd\] = examples$/);
		assert.doesNotMatch(ch, /fav/);
		assert.match((await handleCommand("help", { isDM: true }))!, /\nfav add \[stop\]\n/);
	});
	it("uses the words riders type under meshcore-bot, and accepts them as topics", async () => {
		const say = { bus: "bus", alerts: "busalerts", stops: "stops", fav: "fav", help: "bushelp" };
		const h = (await handleCommand("help", { isDM: false, say }))!;
		assert.match(h, /\nbusalerts \[stop\]\n/);
		assert.match(h, /\nbushelp \[cmd\] = examples$/);
		assert.doesNotMatch(h, /info stats/);
		assert.match((await handleCommand("help busalerts", { isDM: false, say }))!, /\nbusalerts 1120 11\n/);
		assert.match((await handleCommand("stops", { isDM: false, say }))!, /stops pine 4th/);
	});
});

describe("Cascadia: several agencies", () => {
	const EVERETT = { lat: 47.976, lon: -122.198 };
	const DOWNTOWN = { lat: 47.6, lon: -122.3 };
	// the router reads the real clock; pin it to the fixture's Tuesday morning
	const realNow = Date.now;
	before(() => (Date.now = () => TUE_0810));
	after(() => (Date.now = realNow));
	it("skips feeds that haven't been downloaded", () => {
		assert.deepEqual([...gtfs.feeds.keys()], ["kcm", "ct"]);
	});
	it("picks the stop nearest the rider when agencies share a number", async () => {
		assert.equal(
			await handleCommand("bus 1120", { isDM: false, near: EVERETT }),
			"Everett Station Bay 3 · CT\n201 - 6 mins (s)\nSwift Blue - 20 mins (s)\nalso: 1120",
		);
		assert.match((await handleCommand("bus 1120", { isDM: false, near: DOWNTOWN }))!, /^3rd Ave & Pike St, Bay 2\n/);
	});
	it("falls back to Metro without a location, and an agency code overrides", async () => {
		assert.match((await handleCommand("bus 1120", { isDM: false }))!, /^3rd Ave & Pike St, Bay 2\n.*\nalso: ct 1120$/s);
		assert.match((await handleCommand("bus ct 1120", { isDM: false, near: DOWNTOWN }))!, /^Everett Station Bay 3 · CT\n/);
		assert.match((await handleCommand("bus swift 1120", { isDM: false }))!, /^Everett Station Bay 3 · CT\n/);
		assert.match((await handleCommand("bus ct 5000", { isDM: false }))!, /^Colby Ave & Pacific Ave · CT\n201 - 12 mins/);
	});
	it("uses the agency that actually runs the requested route", async () => {
		assert.equal(await handleCommand("bus 1120 201", { isDM: false }), "201 @ Everett Station Bay 3 · CT\n6 mins (s)");
		assert.match((await handleCommand("bus 1120 swift blue", { isDM: false }))!, /^Swift Blue @ Everett Station/);
		assert.match((await handleCommand("bus 1120 11", { isDM: false, near: EVERETT }))!, /^11 @ 3rd Ave & Pike/);
	});
	it("shows other agencies' stops with their code in stop search", async () => {
		assert.equal(
			await handleCommand("stops everett station", { isDM: false }),
			"everett station:\nct 1120 Everett Station Bay 3 → 201, Swift Blue",
		);
	});
	it("saves favorites per agency, and reads old bare favorites as Metro", async () => {
		const key = "dd".repeat(32);
		store.users.set(key, { pubKey: key, advName: "Rider", favoriteStops: ["11040"], firstSeen: 0, lastSeen: 0, type: 1, flags: 0, outPathLen: -1, outPath: "", lastAdvert: 0, advLat: 0, advLon: 0 });
		const dm = { isDM: true, pubKey: key };
		assert.equal(await handleCommand("fav add ct 1120", dm), "Saved Everett Station Bay 3 (ct 1120).");
		assert.equal(await handleCommand("fav list", dm), "Favorites:\n11040 Broadway & E Pine St\nct 1120 Everett Station Bay 3");
		assert.deepEqual(store.users.get(key)!.favoriteStops, ["11040", "ct:1120"]);
		assert.equal(await handleCommand("fav rm 1120", dm), "Removed ct 1120.");
	});
	it("credits every loaded agency", async () => {
		assert.equal(await handleCommand("info", { isDM: false }), "Transit data: King County Metro (by permission), Community Transit.");
	});
	it("decodes protobuf GTFS-realtime and maps OneBusAway route ids to agencies", async () => {
		const { transit_realtime: rt } = (await import("gtfs-realtime-bindings")).default;
		const pb = rt.FeedMessage.encode(
			rt.FeedMessage.create({
				header: { gtfsRealtimeVersion: "2.0", timestamp: 1 },
				entity: [{ id: "1", tripUpdate: { trip: { tripId: "C1" }, stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 300 } }] } }],
			}),
		).finish();
		const realFetch = globalThis.fetch;
		const { clearRealtimeCache } = await import("../realtime");
		clearRealtimeCache();
		gtfs.feeds.get("ct")!.tripUpdates = { url: "https://example.test/ct.pb", format: "pb" };
		globalThis.fetch = (async () => new Response(pb)) as unknown as typeof fetch;
		try {
			assert.equal(await handleCommand("bus ct 1120 201", { isDM: false }), "201 @ Everett Station Bay 3 · CT\n11 mins");
		} finally {
			globalThis.fetch = realFetch;
			delete gtfs.feeds.get("ct")!.tripUpdates;
		}
	});
});

describe("outage mode", () => {
	const realFetch = globalThis.fetch;
	const realNow = Date.now;
	let clock = TUE_0810;
	let calls = 0;
	let netUp = true;
	before(async () => {
		Date.now = () => clock;
		globalThis.fetch = (async (url: string) => {
			calls++;
			if (!netUp) throw new TypeError("fetch failed");
			return realFetch(url);
		}) as typeof fetch;
	});
	after(() => {
		Date.now = realNow;
		globalThis.fetch = realFetch;
		process.env.OBA_API_KEY = "";
	});
	const reset = async () => {
		(await import("../realtime")).clearRealtimeCache();
		clock = TUE_0810;
		calls = 0;
		netUp = true;
		process.env.OBA_API_KEY = "";
	};
	const ask = (msg: string) => handleCommand(msg, { isDM: false });

	it("says when it's running on the schedule because live data is unreachable", async () => {
		await reset();
		netUp = false;
		assert.equal(
			await ask("bus 1120"),
			// the 8:12 trip was cancelled, but only live data says so
			"3rd Ave & Pike St, Bay 2\n11 - 2 mins (s)\nG Line - 3 mins (s)\noffline: schedule times only\nalso: ct 1120",
		);
	});
	it("stops retrying a dead source for a minute instead of making every rider wait", async () => {
		await reset();
		netUp = false;
		await ask("bus 1120");
		const after1 = calls;
		await ask("bus 1120 11");
		await ask("bus 11040");
		assert.equal(calls, after1, "no new fetches while the source is being skipped");
		clock += 61_000;
		await ask("bus 1120");
		assert.equal(calls, after1 + 1, "tries again after a minute");
	});
	it("rides out a short blip on recent live data, then admits it's offline", async () => {
		await reset();
		assert.match((await ask("bus 1120"))!, /\n11 - 5 mins\n/); // live: 15 min late
		netUp = false;
		clock += 40_000; // cache expired, fetch fails, data is 40 s old
		const blip = (await ask("bus 1120"))!;
		assert.match(blip, /\n11 - 4 mins\n/);
		assert.doesNotMatch(blip, /offline/);
		clock += 6 * 60_000; // data now too old to trust
		assert.match((await ask("bus 1120"))!, /\noffline: schedule times only\n/);
	});
	it("never reports an all-clear it couldn't check", async () => {
		await reset();
		netUp = false;
		assert.equal(await ask("alerts 1120"), "3rd Ave & Pike St, Bay 2\nCan't reach live alerts right now.\nalso: ct 1120");
		assert.equal(await ask("alerts ct 1120"), "Everett Station Bay 3 · CT\nNo live alerts feed for Community Transit yet.");
	});
	it("doesn't call an agency with no live feed offline", async () => {
		await reset();
		netUp = false;
		assert.doesNotMatch((await ask("bus ct 1120"))!, /offline/);
	});
	it("with OneBusAway: its outage alone isn't offline if the agency's own feed works", async () => {
		await reset();
		process.env.OBA_API_KEY = "k";
		globalThis.fetch = (async (url: string) => {
			calls++;
			if (String(url).includes("onebusaway")) throw new TypeError("fetch failed");
			return realFetch(url);
		}) as typeof fetch;
		try {
			const metro = (await ask("bus 1120"))!;
			assert.match(metro, /\n11 - 5 mins\n/);
			assert.doesNotMatch(metro, /offline/);
			// CT's live data would come only from OneBusAway, which is down
			assert.match((await ask("bus ct 1120"))!, /\noffline: schedule times only$/);
		} finally {
			globalThis.fetch = (async (url: string) => {
				calls++;
				if (!netUp) throw new TypeError("fetch failed");
				return realFetch(url);
			}) as typeof fetch;
		}
	});
});
