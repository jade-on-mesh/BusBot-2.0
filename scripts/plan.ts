// The trip planner's options side by side, for checking its choices:
//   npx tsx --env-file=.env scripts/plan.ts "capitol hill" "redmond technology"
// prints the best plan with at most 1, 2, 3 and 4 rides, then the one "go" picks.
import { loadGtfs, stopRef } from "../gtfs";
import { formatPlan, planStops, planTrip, resolvePlace } from "../planner";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
	console.log('Usage: npx tsx --env-file=.env scripts/plan.ts "<from>" "<to>"');
	process.exit(1);
}
loadGtfs();
const now = Date.now();
const a = await resolvePlace(from, { isDM: true });
const b = await resolvePlace(to, { isDM: true });
if ("error" in a) throw new Error(a.error);
if ("error" in b) throw new Error(b.error);
for (const [label, c] of [[from, a.cands], [to, b.cands]] as const) {
	const names = planStops(c).slice(0, 8).map(([s, sec]) => `${stopRef(s)} ${s.stop_name}${sec ? ` (${Math.round(sec / 60)} min walk)` : ""}`);
	console.log(`"${label}": ${c.size} stops\n  ${names.join("\n  ")}`);
}
console.log();
for (const rides of [1, 2, 3, 4]) {
	const p = planTrip(a.cands, b.cands, now, rides);
	console.log(`--- at most ${rides} ride${rides > 1 ? "s" : ""}`);
	console.log(p && p !== "here" ? formatPlan(p, now) : String(p ?? "none"));
}
const chosen = planTrip(a.cands, b.cands, now);
console.log("--- go picks");
console.log(chosen && chosen !== "here" ? formatPlan(chosen, now) : String(chosen ?? "none"));
