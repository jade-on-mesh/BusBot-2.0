import { em, emojiOn } from "../style";

// Riders type different words depending on setup: standalone BusBot uses
// "alerts", but under meshcore-bot (whose own alert command owns that word)
// it's "busalerts". The plugin sends its word map, so help shows what to type.
export type Words = Record<string, string>;
const word = (say: Words | undefined, canonical: string) => say?.[canonical] ?? canonical;

// help
export const help = (isDM = false, say?: Words) => {
	const w = (c: string) => word(say, c);
	const lines = [
		em("🚌", "Transit:"),
		`${w("bus")} [stop] [route]`,
		`${w("stops")} [streets/address]`,
		`${w("alerts")} [stop]`,
	];
	if (isDM) lines.push(`${w("fav")} · ${w("watch")} · ${w("commute")}`);
	// Standalone BusBot also answers these; under meshcore-bot they're its own.
	if (!say && !isDM) lines.push("info stats beats");
	// DM help has one more line, so its footer is shorter to stay one message
	lines.push(isDM ? `${w("help")} [cmd]` : `${w("help")} [cmd] = examples`);
	return lines.join("\n");
};

// help alerts
export const helpAlerts = (say?: Words) => {
	const a = word(say, "alerts");
	return `${em("⚠️", "Service alerts. Ex:")}\n${a} 11040\n${a} 1120 11\n${a} 120 G Line`;
};

// help beats
export const helpBeats = () => {
	return "Returns the current time in .beats (Swatch Internet Time)";
};

// help bus
export const helpBus = (say?: Words) => {
	const b = word(say, "bus");
	const sched = emojiOn() ? "🕒" : "(s)";
	return `${em("🚌", `Next arrivals (${sched} = scheduled). Ex:`)}\n${b} 11040\n${b} 1120 11\n${b} 120 G Line`;
};

// help fav
export const helpFav = (say?: Words) => {
	const f = word(say, "fav");
	return `${em("⭐", "DM only, up to 5 stops:")}\n${f} add 11040\n${f} rm 11040\n${f} list\n${f} = arrivals for all`;
};

// help watch
export const helpWatch = (say?: Words) => {
	const x = word(say, "watch");
	return `${em("🚨", "DM when your bus is close:")}\n${x} 1120 11\n${x} 1120 11 10m\n${x} = list\nun${x} [n]`;
};

// help commute
export const helpCommute = (say?: Words) => {
	const c = word(say, "commute");
	return `${em("⏰", "Weekday DM of arrivals:")}\n${c} 8:05 1120 11\n${c} 5:30pm ct 1120\n${c} = list\n${c} off [n]`;
};

// help info
export const helpInfo = () => {
	return "Transit scheduling, geographic, and real-time data provided by permission of King County.";
};

export const helpStats = () => {
	return "Returns the number of queries answered since the service was started.";
};

export const helpAdmin = () => {
	return "Admin (DM): block name [n], block key [hex], unblock name|key [x], blocklist";
};
