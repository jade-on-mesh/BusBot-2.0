// Quiet-channel alert posts.
//
// When the bot's channel has had no traffic for an hour and there are active
// service alerts, post one: the most severe, then the newest, that hasn't
// been posted in the last 24 hours. The post itself counts as traffic, so
// that's at most one an hour, and none overnight (ALERT_QUIET_HOURS).
//
// Callers own the "channel has been quiet" part (they see the traffic);
// nextBroadcast() picks and formats the alert.
import { Alert, getAlertsFor } from "./realtime";
import { agencyCode, defaultAgency, feeds, routesByKey, shortName } from "./gtfs";
import { alertText, isActive } from "./commands/alerts";
import { readJson, writeJson } from "./store";
import { em } from "./style";
import { localParts } from "./time";

const REPOST_AFTER_MS = 24 * 3600_000;
const MAX_BYTES = 115; // one channel message

export const broadcastsEnabled = () => !/^(0|false|off|no)$/i.test((process.env.ALERT_POSTS ?? "").trim());
export const quietMinutes = () => Math.max(10, parseInt(process.env.ALERT_QUIET_MINUTES || "60") || 60);

// "22-6" (default): no posts from 22:00 to 05:59 local. "off" posts any time.
export const inQuietHours = (nowMs: number) => {
	const raw = (process.env.ALERT_QUIET_HOURS ?? "22-6").trim().toLowerCase();
	const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw);
	if (!m) return false;
	const [from, to] = [parseInt(m[1]) % 24, parseInt(m[2]) % 24];
	const { hour } = localParts(nowMs);
	return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
};

const FILE = "broadcasts.json";
const posted = readJson<{ posted: Record<string, number> }>(FILE, { posted: {} }).posted;
export const resetBroadcasts = () => Object.keys(posted).forEach((k) => delete posted[k]); // tests

const SEVERITY: Record<string, number> = { SEVERE: 3, WARNING: 2, INFO: 1, UNKNOWN_SEVERITY: 1 };
const rank = (a: Alert) => SEVERITY[String(a.alert.severity_level ?? "").toUpperCase()] ?? 1;
const recency = (a: Alert) =>
	a.alert.last_modified_timestamp ?? a.alert.created_timestamp ?? a.alert.active_period?.[0]?.start ?? 0;

const fitBytes = (s: string, max: number) => {
	if (Buffer.byteLength(s) <= max) return s;
	let cut = s;
	while (cut && Buffer.byteLength(`${cut}…`) > max) cut = [...cut].slice(0, -1).join("");
	return `${cut.trimEnd()}…`;
};

const format = (a: Alert) => {
	const routes = [
		...new Set(
			(a.alert.informed_entity ?? [])
				.map((e) => e.route_id && routesByKey.get(`${a.agency}:${e.route_id}`))
				.filter(Boolean)
				.map((r) => shortName(r || undefined)),
		),
	];
	const shown = routes.slice(0, 3).join("/") + (routes.length > 3 ? "+" : "");
	const agency = a.agency === defaultAgency ? "" : agencyCode(a.agency).toUpperCase();
	const label = [agency, shown].filter(Boolean).join(" ");
	return fitBytes(em("⚠️", `${label ? `${label}: ` : ""}${alertText(a)}`), MAX_BYTES);
};

// The next alert worth posting, or null. Marks it as posted.
export const nextBroadcast = async (nowMs = Date.now()): Promise<string | null> => {
	if (!broadcastsEnabled() || inQuietHours(nowMs)) return null;
	const candidates: Alert[] = [];
	for (const id of feeds.keys()) {
		const { alerts, status } = await getAlertsFor(id);
		if (status === "down" || status === "none") continue;
		for (const a of alerts) {
			const key = `${a.agency}:${a.id}`;
			if (!isActive(a, nowMs)) continue;
			if (posted[key] && nowMs - posted[key] < REPOST_AFTER_MS) continue;
			candidates.push(a);
		}
	}
	if (!candidates.length) return null;
	candidates.sort((x, y) => rank(y) - rank(x) || recency(y) - recency(x));
	const pick = candidates[0];
	posted[`${pick.agency}:${pick.id}`] = nowMs;
	for (const [k, t] of Object.entries(posted)) if (nowMs - t > 2 * REPOST_AFTER_MS) delete posted[k];
	writeJson(FILE, { posted });
	return format(pick);
};
