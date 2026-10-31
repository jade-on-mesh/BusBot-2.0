# BusBot
BusBot provides information about King County Metro buses and routes over MeshCore. Transit scheduling, geographic, and real-time data provided by permission of King County.

## Getting Started
1. Download and extract the GTFS base data available from [King County Metro](https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps#toc-developer-resources) to the `metro/txt` folder.
2. `npm install`
3. `npm run setup` to convert the GTFS text files to JSON. Run this again whenever you download a new feed. The bot posts a warning in its channel when the feed is within 14 days of expiring.
4. Copy `.env.example` to `.env` and fill it in. At minimum: `SERIAL_PORT`, `NODE_NAME`, `BOT_CHANNEL`, and the two GTFS-RT feed URLs.
5. Add the bot channel (e.g. `#transit`) on the companion radio, then `npm start`.

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
