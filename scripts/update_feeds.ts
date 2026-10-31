// Downloads and converts every agency's schedule listed in feeds.json.
//
//   npm run feeds              all agencies
//   npm run feeds -- kcm st    just these
//
// Each feed goes to data/<id>/json. The previous data stays in place until a
// new download converts cleanly, so a failed download never leaves the bot
// without a schedule. Restart BusBot afterwards to load the new data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { feedDir, readFeedConfig } from "../gtfs";
import { parseGtfsDate } from "../time";
import { convertFolder } from "./convert_txt";

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const feeds = readFeedConfig().filter((f) => !only.length || only.includes(f.id));
if (!feeds.length) {
	console.error(`No feeds match: ${only.join(", ")}`);
	process.exit(1);
}

try {
	execFileSync("unzip", ["-v"], { stdio: "ignore" });
} catch {
	console.error("This needs the unzip command: sudo apt install -y unzip");
	process.exit(1);
}

const latestServiceDate = (jsonDir: string) => {
	// feed_info end date if present, else the last date in calendar.txt
	const read = (name: string) => {
		const f = path.join(jsonDir, `${name}.json`);
		return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, string>[]) : [];
	};
	const end = read("feed_info")[0]?.feed_end_date;
	if (end) return end;
	const dates = [
		...read("calendar").map((c) => c.end_date),
		...read("calendar_dates").map((c) => c.date),
	].filter(Boolean);
	return dates.sort().at(-1);
};

const summary: string[] = [];
let failures = 0;

for (const f of feeds) {
	if (!f.url) {
		summary.push(`  ${f.id.padEnd(5)} skipped (no url)`);
		continue;
	}
	const dir = feedDir(f);
	const work = path.join(dir, "download");
	fs.rmSync(work, { recursive: true, force: true });
	fs.mkdirSync(path.join(work, "txt"), { recursive: true });
	process.stdout.write(`${f.name}: downloading… `);
	try {
		const res = await fetch(f.url, {
			headers: { "User-Agent": "BusBot-2.0 (https://github.com/jade-on-mesh/BusBot-2.0)" },
			signal: AbortSignal.timeout(120_000),
			redirect: "follow",
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const zip = path.join(work, "gtfs.zip");
		fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
		const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
		process.stdout.write(`${mb} MB, converting… `);

		// -j: some agencies wrap the files in a folder inside the zip
		try {
			execFileSync("unzip", ["-o", "-q", "-j", zip, "*.txt", "-d", path.join(work, "txt")], { stdio: "pipe" });
		} catch {
			throw new Error("download isn't a valid GTFS zip (the agency may have moved it)");
		}
		if (!fs.existsSync(path.join(work, "txt", "stops.txt"))) throw new Error("zip has no stops.txt");
		const results = await convertFolder(path.join(work, "txt"), path.join(work, "json"), true);
		const stops = results.find((r) => r.file === "stops.txt")?.rows ?? 0;
		if (!stops) throw new Error("no stops converted");

		// Swap the new data in, then clean up.
		const live = path.join(dir, "json");
		const old = path.join(dir, "json.old");
		fs.rmSync(old, { recursive: true, force: true });
		if (fs.existsSync(live)) fs.renameSync(live, old);
		fs.renameSync(path.join(work, "json"), live);
		fs.rmSync(old, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });

		const end = latestServiceDate(live);
		const endDate = end ? parseGtfsDate(end) : undefined;
		const expired = endDate && endDate.valueOf() < Date.now();
		console.log(`${stops} stops ✔`);
		summary.push(
			`  ${f.id.padEnd(5)} ${String(stops).padStart(6)} stops  valid until ${end ?? "?"}${expired ? "  ⚠ EXPIRED, agency hasn't published a new feed" : ""}`,
		);
	} catch (e) {
		failures++;
		fs.rmSync(work, { recursive: true, force: true });
		console.log(`failed: ${(e as Error).message}`);
		summary.push(`  ${f.id.padEnd(5)} FAILED (${(e as Error).message}); previous data kept`);
	}
}

console.log(`\n${summary.join("\n")}\n`);
if (fs.existsSync("data/kcm/json") && fs.existsSync("metro/json")) {
	console.log("Metro now lives in data/kcm. The old metro/ folder can be deleted: rm -rf metro\n");
}
console.log("Restart BusBot to load the new data.");
process.exit(failures === feeds.length ? 1 : 0);
