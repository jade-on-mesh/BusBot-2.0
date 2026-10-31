// Time helpers. Everything is computed in the transit agency's time zone
// (not the host's), so the bot gives correct answers even on a Pi left on UTC.

export const TIMEZONE = process.env.TIMEZONE || "America/Los_Angeles";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: TIMEZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23", // avoids the "24:05:00" midnight bug of hour12:false
});

export const localParts = (epochMs: number) => {
	const p: Record<string, string> = {};
	for (const { type, value } of partsFormatter.formatToParts(new Date(epochMs))) p[type] = value;
	return {
		year: parseInt(p.year),
		month: parseInt(p.month),
		day: parseInt(p.day),
		hour: parseInt(p.hour),
		minute: parseInt(p.minute),
		second: parseInt(p.second),
	};
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type ServiceDay = {
	date: string; // YYYYMMDD
	weekday: string; // "monday" etc. to match calendar.txt columns
	startEpochMs: number; // epoch ms of 00:00:00 on this service day
};

// GTFS times are seconds after the start of the *service day*, and can exceed
// 24:00:00 for trips that run past midnight. To find the next buses we have to
// look at both today's and yesterday's service days.
export const serviceDays = (nowMs: number): ServiceDay[] => {
	const { year, month, day, hour, minute, second } = localParts(nowMs);
	const secondsIntoToday = hour * 3600 + minute * 60 + second;
	const todayStart = nowMs - secondsIntoToday * 1000 - (nowMs % 1000);
	return [0, 1].map((back) => {
		const d = new Date(Date.UTC(year, month - 1, day - back));
		const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
			d.getUTCDate(),
		).padStart(2, "0")}`;
		return {
			date,
			weekday: DAY_NAMES[d.getUTCDay()],
			// Approximation: ignores the one-hour shift on DST changeover days.
			startEpochMs: todayStart - back * 24 * 3600 * 1000,
		};
	});
};

export const gtfsTimeToSeconds = (t: string): number => {
	const [h, m, s] = t.split(":").map((n) => parseInt(n, 10));
	return h * 3600 + m * 60 + (s || 0);
};

// Parses GTFS "YYYYMMDD" dates. `new Date("20260315")` is Invalid Date,
// which is why the original feed-expiry warning never fired.
export const parseGtfsDate = (yyyymmdd: string): Date | undefined => {
	const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd?.trim() ?? "");
	if (!m) return undefined;
	return new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
};

// "now", "1 min", "12 mins", or a local clock time like "14:05" for later buses.
export const prettyTime = (nowMs: number, arrivalMs: number) => {
	const difference = (arrivalMs - nowMs) / 1000;
	if (difference < 75) return "now";
	if (difference < 120) return "1 min";
	if (difference < 60 * 60) return `${Math.floor(difference / 60)} mins`;
	const { hour, minute } = localParts(arrivalMs);
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};
