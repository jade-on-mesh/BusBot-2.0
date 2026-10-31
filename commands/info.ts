import { feeds } from "../gtfs";
import { em } from "../style";

// Credits every agency whose data is loaded (feeds.json "credit", else name).
export const info = () => {
  const names = [...feeds.values()].map((f) => f.credit ?? f.name);
  return em("ℹ️", `Transit data: ${names.length ? names.join(", ") : "King County Metro (by permission)"}.`);
};
