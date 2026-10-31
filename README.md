# BusBot
BusBot provides information about King County Metro buses and routes over MeshCore. Transit scheduling, geographic, and real-time data provided by permission of King County, and by the open data programs of the other agencies in `feeds.json`.

## Getting Started
1. `npm install` (needs Node 20+ and the `unzip` command)
2. `npm run feeds` downloads and converts the schedule for every agency in `feeds.json`. `npm run feeds -- kcm st` refreshes just those. Agencies replace their schedules every few months, so set up the weekly refresh in `integrations/systemd/` (`busbot-feeds.timer`), which re-downloads and restarts BusBot automatically.
3. Copy `.env.example` to `.env` and fill it in. At minimum: `SERIAL_PORT`, `NODE_NAME`, `BOT_CHANNEL`.
4. Add the bot channel (e.g. `#transit`) on the companion radio, then `npm start`.

## Agencies
BusBot covers the Puget Sound region: King County Metro, Sound Transit (Link, Sounder, ST Express), Community Transit, Pierce Transit, Everett Transit, Intercity Transit, Kitsap Transit, Washington State Ferries and the Seattle Center Monorail. Add or remove agencies in `feeds.json`.

Agencies reuse stop numbers, so when a rider sends `bus 1120` and several agencies have a stop 1120, BusBot answers for the one nearest the rider's advertised position (Metro if it doesn't know), and adds `also: ct 1120` so they can ask for the other. Riders can always name the agency: `bus ct 1120`, `bus st 99603`. A route also settles it: `bus 1120 201` answers from the agency that runs a 201 there.

Live arrivals come from OneBusAway for every agency once `OBA_API_KEY` is set. Without a key, Metro (its own feed) and Kitsap Transit are live and the rest show scheduled times (🕒).

## Commands
| Command | Where | What it does |
| --- | --- | --- |
| `bus [stop]` | channel, DM | Next arrival for each route at a stop |
| `bus [stop] [route]` | channel, DM | Next 5 arrivals for one route (`bus 1120 11`, `bus 120 G Line`) |
| `alerts [stop]` / `alerts [stop] [route]` | channel, DM | Active service alerts |
| `fav add [stop]` / `fav rm [stop]` / `fav list` | DM | Save up to 5 favorite stops |
| `fav` | DM | Arrivals for all your favorite stops |
| `info`, `stats`, `beats`, `ping`, `help` | channel, DM | |
| `block name [n]` / `block key [hex]` / `unblock …` / `blocklist` | DM, admins only | Moderation |

`(s)` after a time means it's from the schedule because no live data was available for that trip.

## Real-time data
If `OBA_API_KEY` is set, BusBot asks [OneBusAway Puget Sound](https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd) first. If that fails or isn't configured, it uses the King County Metro GTFS-RT trip updates feed on top of the static schedule. Responses are cached for 30 seconds.

## Ride alarms
In a DM to the bot:
- `watch 1120 11` DMs you once when the next 11 is 5 minutes from stop 1120 (`watch 1120 11 10m` for 10). If a bus is already that close when you ask, it watches for the one after. `watch` lists yours, `unwatch [n]` cancels.
- `commute 8:05 1120 11` DMs you that stop's arrivals every weekday at 8:05. `commute` lists, `commute off [n]` cancels.

To stay polite on the mesh: 3 watches and 2 commutes per rider, watches end after firing or after 90 minutes (with one notice), commutes run weekdays only and once a day. Alarms survive restarts (`db/alarms.json`).

With meshcore-bot, alarms are sent by `integrations/meshcore-bot/busbot_alarms_service.py`: copy it into meshcore-bot's `local/service_plugins/` and add `[BusBot_Alarms]` with `enabled = true` to `local/config.ini`.

## Alert posts on a quiet channel
When the bot's channel has had no traffic for an hour and there are active service alerts, BusBot posts one: the most severe, then the newest, never the same one twice within 24 hours. Its own post counts as traffic, so that's at most one an hour, and none overnight (10 pm to 6 am by default). Settings: `ALERT_POSTS`, `ALERT_QUIET_MINUTES`, `ALERT_QUIET_HOURS` in `.env` (standalone), or `alert_posts`, `channel`, `quiet_minutes` under `[BusBot_Alarms]` (meshcore-bot; quiet hours still come from BusBot's `.env`).

## Outage mode
BusBot is built to keep answering when the internet doesn't. Schedules for every agency live on the Pi, so `bus`, `stops` (cross streets) and favorites keep working with no connection at all.

- If a live source stops answering, BusBot keeps using its most recent data for up to 5 minutes, which rides out brief blips without riders noticing.
- After that, replies end with `📴 offline: schedule times only`, so riders know the times are timetable, not tracking.
- A dead source is skipped for a minute at a time, so riders aren't each kept waiting by a timeout.
- `alerts` never reports an all-clear it couldn't check: it says `📴 Can't reach live alerts right now` instead.
- Agencies with no live feed at all just show 🕒 scheduled times, with no outage notice.
- `curl localhost:8787/health` shows each live source's state under `live`.

## Users and contacts
A companion radio can only hold so many contacts, and it can only read DMs from contacts it holds. BusBot saves every rider it hears (public key, name, favorites) in `db/users.json` and treats the radio's contact table as a cache. When it reaches `MAX_CONTACTS` companions, the rider who least recently used the bot is removed from the radio to make room. Their favorites stay saved, and their next advert puts them back. Keys listed in `ADMIN_KEYS` are never evicted.

## Moderation
Set `ADMIN_KEYS` to your own public key (or a 6+ hex character prefix of it). Admins can DM `block name Some Name` or `block key a1b2c3` to stop the bot answering someone, in channel or by DM. Blocks are saved in `db/blocklist.json`. `BLOCKED_NAMES` and `BLOCKED_KEYS` in `.env` are applied as well.

## Sharing a radio with meshcore-bot
BusBot can run without its own radio and answer through meshcore-bot instead:

1. `npm run serve` starts a local-only API on `127.0.0.1:8787` (`BUSBOT_PORT` to change). Run it as a service with `integrations/meshcore-bot/busbot-api.service`.
2. Copy `integrations/meshcore-bot/busbot_command.py` into meshcore-bot's `local/commands/` folder and restart meshcore-bot.
3. Riders use `bus`, `busalerts` and `fav` (meshcore-bot's own alert command owns `alerts`). Set `channels = #transit` under `[BusBot_Command]` to answer only there; meshcore-bot's other commands won't answer in a channel they don't monitor. If the bot's radio doesn't have the channel yet, stop the bot and run `npx tsx scripts/add_channel.ts <serial port> "#transit"`. Other options (URL, keyword renames) go in meshcore-bot's `local/config.ini` under `[BusBot_Command]`; see the top of the plugin file.

In this mode meshcore-bot owns the contacts, so BusBot's contact eviction doesn't apply. `SERIAL_PORT`, `NODE_NAME` and `BOT_CHANNEL` aren't needed.

## Development
- `npm test` runs the test suite against synthetic GTFS in `test/fixtures` (no network or radio needed)
- `npm run typecheck`
