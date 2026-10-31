// help
export const help = (isDM = false) => {
	return `Commands:\n• alerts\n• bus${isDM ? "\n• fav" : ""}\n• info\n---\n• beats\n• stats`;
};

// help alerts
export const helpAlerts = () => {
	return "Use alerts [stop] or alerts [stop] [route] for alerts. Ex:\nalerts 11040\nalerts 1120 11\nalerts 120 G Line";
};

// help beats
export const helpBeats = () => {
	return "Returns the current time in .beats (Swatch Internet Time)";
};

// help bus
export const helpBus = () => {
	return "Use bus [stop] or bus [stop] [route] for arrivals. (s) = scheduled, no live data. Ex:\nbus 11040\nbus 1120 11\nbus 120 G Line\nbus 1651 First Hill Streetcar";
};

// help fav
export const helpFav = () => {
	return `DM only. Save up to 5 stops:\nfav add 11040\nfav rm 11040\nfav list\nfav (arrivals for all)`;
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
