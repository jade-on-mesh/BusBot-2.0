// Map pins: the transit layer for MeshCore Open TAK, MeshCore Open and
// Wadamesh standalones.
//
// Those clients all read a shared map pin from any chat message:
//   m:<lat>,<lon>|<label>|<flags>
// and show the newest pin per (conversation, sender, label, flags) on their
// map. So a stop BusBot mentions can land on the rider's map as a pin they
// can tap, with no app changes. A pin has to be its own message (the app
// shows a message with a pin as just the pin), so pins go out after the
// text reply, one per message.
//
// Commands record the stops they talk about with notePin(); the router
// decides whether to send them: `pin [stop]` always does, and `pins on`
// (DM) adds them to that rider's DM replies.
import { AsyncLocalStorage } from "node:async_hooks";
import { Stop, stopRef } from "./gtfs";
import { findUserByPrefix, flushUsers, users } from "./store";
import { em } from "./style";

export const PIN_FLAGS = "bus"; // shows as the pin's type; ≤8 bytes for Wadamesh
const MAX_LABEL_BYTES = 32; // Wadamesh keeps 32 bytes of a label
export const MAX_PINS = 3; // per reply: each one is another message on the mesh

type Pin = { lat: number; lon: number; label: string };
const scope = new AsyncLocalStorage<Pin[]>();

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Plain text (Wadamesh fonts have no emoji), no "|" or line breaks, and cut
// on a character boundary to fit.
export const pinLabel = (text: string) => {
	let s = text
		.replace(/[|]/g, "/")
		.replace(/\s+/g, " ")
		.replace(/\p{Extended_Pictographic}️?/gu, "")
		.trim();
	if (bytes(s) <= MAX_LABEL_BYTES) return s;
	const chars = Array.from(s);
	while (chars.length && bytes(chars.join("")) + 3 > MAX_LABEL_BYTES) chars.pop();
	return `${chars.join("").trimEnd()}…`;
};

export const formatPin = (p: Pin) => `m:${p.lat.toFixed(5)},${p.lon.toFixed(5)}|${pinLabel(p.label)}|${PIN_FLAGS}`;
export const isPinLine = (line: string) => /^m:-?[0-9.]+,-?[0-9.]+\|/.test(line);

// Records a stop (or a labelled point) the current reply is about. A no-op
// outside a command, so commands can call it unconditionally.
export const notePin = (stop: Stop, label?: string) => {
	const pins = scope.getStore();
	if (!pins) return;
	const lat = parseFloat(stop.stop_lat ?? "");
	const lon = parseFloat(stop.stop_lon ?? "");
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
	const text = label ?? `${stopRef(stop)} ${stop.stop_name}`;
	if (pins.some((p) => p.label === text)) return;
	pins.push({ lat, lon, label: text });
};

// Runs a command, collecting the pins it notes.
export const withPins = async <T>(run: () => Promise<T>): Promise<{ result: T; pins: Pin[] }> => {
	const pins: Pin[] = [];
	const result = await scope.run(pins, run);
	return { result, pins };
};

// Appends pins as their own lines; divideReply and the meshcore-bot plugin
// send each as a separate message.
export const withPinLines = (reply: string, pins: Pin[]) =>
	pins.length ? [reply, ...pins.slice(0, MAX_PINS).map(formatPin)].join("\n") : reply;

// ---------- per-rider setting ----------

const userFor = (pubKey?: string) => (pubKey ? users.get(pubKey) ?? findUserByPrefix(pubKey) : undefined);

export const pinsOn = (pubKey?: string) => !!userFor(pubKey)?.mapPins;

// pins / pins on / pins off (DM)
export const pinsCommand = (pubKey: string | undefined, args: string[], say?: Record<string, string>) => {
	const word = say?.pins ?? "pins";
	const user = userFor(pubKey);
	const arg = args[0];
	if (!user) return "I don't know your radio yet. Send an advert, then try again.";
	if (arg === "on" || arg === "off") {
		user.mapPins = arg === "on";
		flushUsers();
	}
	return user.mapPins
		? em("🗺️", `Map pins on: stops in my DM replies also land on your map. ${word} off to stop.`)
		: em("🗺️", `Map pins off. ${word} on puts stops from my DM replies on your map (MeshCore Open, TAK, Wadamesh).`);
};

export const helpPins = (say?: Record<string, string>) => {
	const p = say?.pins ?? "pins";
	const one = say?.pin ?? "pin";
	return `${em("🗺️", "Stops as map pins:")}\n${one} 1120 = one pin\n${p} on = pins with my DM replies\n${p} off`;
};
