// Converts the GTFS .txt files in metro/txt into JSON in metro/json.
//
// Uses a real RFC 4180 CSV parser (quoted fields, embedded commas, escaped
// quotes, BOM) and streams line by line so the very large stop_times.txt
// doesn't need to be held in memory as one string.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const inputFolder = process.argv[2] || "./metro/txt";
const outputFolder = process.argv[3] || "./metro/json";

// Only keep the columns BusBot actually uses. Keeps memory use down on a Pi.
const KEEP_COLUMNS: Record<string, string[]> = {
	"stop_times.txt": ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
	"trips.txt": ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"],
	"stops.txt": ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"],
	"routes.txt": ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
};

const SKIP_FILES = new Set(["shapes.txt"]); // big and unused

// Parse one CSV line. Returns null if the line ends inside a quoted field
// (multi-line field); the caller appends the next line and retries.
export const parseCsvLine = (line: string): string[] | null => {
	const fields: string[] = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			fields.push(field);
			field = "";
		} else {
			field += ch;
		}
	}
	if (inQuotes) return null;
	fields.push(field);
	return fields;
};

const convertFile = async (fileName: string) => {
	const base = path.basename(fileName);
	const outName = path.join(outputFolder, base.replace(/\.txt$/, ".json"));
	const rl = readline.createInterface({
		input: fs.createReadStream(fileName, "utf8"),
		crlfDelay: Infinity,
	});
	const out = fs.createWriteStream(outName, "utf8");
	let keys: string[] | null = null;
	let keepIdx: number[] = [];
	let pending = "";
	let count = 0;
	let skipped = 0;
	out.write("[");

	for await (const rawLine of rl) {
		const line = pending ? `${pending}\n${rawLine}` : rawLine;
		const fields = parseCsvLine(line);
		if (fields === null) {
			pending = line;
			continue;
		}
		pending = "";
		if (!keys) {
			keys = fields.map((k) => k.replace(/^﻿/, "").trim());
			const keep = KEEP_COLUMNS[base];
			keepIdx = keys
				.map((k, i) => (keep && !keep.includes(k) ? -1 : i))
				.filter((i) => i >= 0);
			continue;
		}
		if (line.trim() === "") continue;
		if (fields.length !== keys.length) {
			skipped++;
			continue;
		}
		const row: Record<string, string> = {};
		for (const i of keepIdx) row[keys[i]] = fields[i].trim();
		out.write((count ? ",\n" : "\n") + JSON.stringify(row));
		count++;
	}
	out.write("\n]\n");
	await new Promise((resolve) => out.end(resolve));
	console.log(`${base}: ${count} rows${skipped ? ` (${skipped} malformed rows skipped)` : ""}`);
};

const main = async () => {
	if (!fs.existsSync(inputFolder)) {
		throw new Error(`Input files not found! Extract the GTFS zip into ${inputFolder}`);
	}
	fs.mkdirSync(outputFolder, { recursive: true });
	const files = fs
		.readdirSync(inputFolder)
		.filter((f) => f.endsWith(".txt") && !SKIP_FILES.has(f))
		.map((f) => path.join(inputFolder, f))
		.filter((f) => fs.lstatSync(f).isFile());
	for (const f of files) {
		try {
			await convertFile(f);
		} catch (err) {
			console.error(`Failed converting ${f}:`, err);
		}
	}
};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
