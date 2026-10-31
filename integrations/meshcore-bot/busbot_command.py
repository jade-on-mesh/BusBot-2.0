#!/usr/bin/env python3
"""
BusBot bridge for meshcore-bot.

Forwards bus / alerts / fav messages to a BusBot instance running in
radio-less API mode (`npm run serve` in the BusBot folder) and sends back
its reply. Install by copying this file into meshcore-bot's local/commands/
folder and restarting meshcore-bot.

Optional settings in local/config.ini:

    [BusBot_Command]
    enabled = true
    # answer only in these channels (plus DMs); leave out to use monitor_channels
    channels = #transit
    url = http://127.0.0.1:8787/command
    timeout = 15
    # where meshcore-bot keeps contact positions (for picking the nearest
    # agency when stop numbers collide); blank disables position lookups
    db_path = /var/lib/meshcore-bot/meshcore_bot.db
    # word riders type = word BusBot understands. Rename a word here if it
    # collides with another meshcore-bot command. "alerts" belongs to
    # meshcore-bot's own alert command, so riders type "busalerts [stop]".
    keywords = bus=bus, busalerts=alerts, stops=stops, near=near, fav=fav, bushelp=help, watch=watch, unwatch=unwatch, commute=commute
    # "help" in a BusBot-only channel (see channels above) also shows BusBot's
    # help, since meshcore-bot's own help doesn't answer there.
"""

import asyncio
import json
import logging
import sqlite3
import time
import urllib.error
import urllib.request

from modules.commands.base_command import BaseCommand
from modules.models import MeshMessage

SECTION = "BusBot_Command"
log = logging.getLogger("busbot_command")

async def ensure_dm_contact(bot, pubkey, state: dict, log) -> None:
    """meshcore-bot replies to DMs from its in-memory contact list
    (bot.meshcore.contacts), which it only loads at startup. In bot-managed
    contacts mode it adds new riders to the radio but doesn't refresh that
    list, so its reply fails with "Contact not found for DM recipient".
    If the rider is missing, reload the list the same way meshcore-bot does
    at startup (at most once every 20 s)."""
    mc = getattr(bot, "meshcore", None)
    key = (pubkey or "").strip().lower()
    if not mc or not key:
        return
    contacts = getattr(mc, "contacts", None) or {}
    for c in contacts.values():
        if (c.get("public_key") or "").lower().startswith(key):
            return
    now = time.time()
    if now - state.get("last_refresh", 0) < 20:
        return
    state["last_refresh"] = now
    try:
        from meshcore_cli.meshcore_cli import next_cmd
        await next_cmd(mc, ["contacts"])
        log.info(f"Refreshed meshcore-bot's contact list for new DM sender {key[:12]}")
    except Exception as e:
        log.warning(f"Couldn't refresh contact list: {e}")

_refresh_state: dict = {}


class BusBotCommand(BaseCommand):
    """King County Metro arrivals, alerts and favorite stops via BusBot."""

    name = "busbot"
    keywords = ["bus", "busalerts", "stops", "near", "fav", "bushelp", "help", "watch", "unwatch", "commute"]
    description = (
        "King County Metro arrivals and alerts. 'bus [stop]', 'bus [stop] [route]', "
        "'busalerts [stop]', 'stops [cross streets or address]'. In DMs: 'fav add [stop]', 'fav'."
    )
    category = "info"
    short_description = "King County Metro arrivals and alerts"
    usage = "bus [stop] [route]"
    examples = ["bus 1120", "bus 1120 11", "bus 120 G Line", "busalerts 1120", "stops pine 4th", "fav add 1120"]
    parameters = [
        {"name": "stop", "description": "Stop number from the bus stop sign"},
        {"name": "route", "description": "Optional route, e.g. 11 or G Line"},
    ]

    def _derive_config_section_name(self) -> str:
        # meshcore-bot derives "channels"/"aliases" lookups from this; pin it so
        # they read the same [BusBot_Command] section as the settings below.
        return SECTION

    def __init__(self, bot):
        super().__init__(bot)
        self.busbot_enabled = self.get_config_value(SECTION, "enabled", fallback=True, value_type="bool")
        self.url = self.get_config_value(SECTION, "url", fallback="http://127.0.0.1:8787/command")
        self.timeout = float(self.get_config_value(SECTION, "timeout", fallback="15"))
        default_db = getattr(getattr(bot, "db_manager", None), "db_path", None) or "/var/lib/meshcore-bot/meshcore_bot.db"
        self.db_path = str(self.get_config_value(SECTION, "db_path", fallback=default_db) or "").strip()
        self._places = {}  # cache key -> (fetched_at, (lat, lon) or None)
        raw = self.get_config_value(SECTION, "keywords", fallback="bus=bus, busalerts=alerts, stops=stops, near=near, fav=fav, bushelp=help, watch=watch, unwatch=unwatch, commute=commute")
        self.word_map = {}
        for pair in str(raw).split(","):
            if "=" in pair:
                said, means = (p.strip().lower() for p in pair.split("=", 1))
                if said and means:
                    self.word_map[said] = means
        self.keywords = list(self.word_map) or ["bus"]
        if "help" not in self.word_map:
            self.keywords.append("help")  # only claimed in BusBot-only channels

    def can_execute(self, message: MeshMessage, skip_channel_check: bool = False) -> bool:
        if not self.busbot_enabled:
            return False
        return super().can_execute(message)

    def matches_keyword(self, message: MeshMessage) -> bool:
        # First word only, so chatter like "busy" or "alerts are annoying" in
        # a channel only triggers when it's actually "alerts [stop]".
        # Note every message in a channel (command or not), so the alarms
        # service knows when the channel has gone quiet.
        if message.channel and not message.is_dm:
            activity = getattr(self.bot, "_busbot_channel_activity", None)
            if activity is None:
                activity = {}
                setattr(self.bot, "_busbot_channel_activity", activity)
            activity[message.channel.lower().strip()] = time.time()
        words = self.cleanup_message_for_matching(message).split()
        if not words:
            return False
        if words[0] == "help" and "help" not in self.word_map:
            return self._in_own_channel(message)
        if words[0] not in self.word_map:
            return False
        means = self.word_map[words[0]]
        if means in ("fav", "watch", "unwatch", "commute"):
            return bool(message.is_dm)  # these need to know who the rider is
        return len(words) == 1 or words[1][:1].isalnum()

    def _in_own_channel(self, message: MeshMessage) -> bool:
        """True in a channel listed under [BusBot_Command] channels, where
        meshcore-bot's other commands (including its help) don't answer."""
        allowed = getattr(self, "allowed_channels", None)
        if message.is_dm or not message.channel or not allowed:
            return False
        return message.channel.lower().strip() in {c.lower().strip() for c in allowed}

    def _words_for(self, message: MeshMessage) -> dict:
        """canonical command -> word riders type, so BusBot's help matches."""
        say = {}
        for said, means in self.word_map.items():
            say.setdefault(means, said)
        if self._in_own_channel(message):
            say["help"] = "help"
        return say

    def _lookup_place(self, message: MeshMessage):
        """The rider's last advertised position from meshcore-bot's contact
        tracking: by public key in DMs, by name in channels (newest match).
        Returns (lat, lon) or None. Never raises."""
        if not self.db_path:
            return None
        key = (message.sender_pubkey or "").strip().lower()
        name = (message.sender_id or "").strip()
        if not key and not name:
            return None
        cache_key = f"k:{key}" if key else f"n:{name}"
        hit = self._places.get(cache_key)
        if hit and time.time() - hit[0] < 300:
            return hit[1]
        place = None
        try:
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=2)
            try:
                where, arg = ("lower(public_key) LIKE ?", key + "%") if key else ("name = ?", name)
                row = conn.execute(
                    "SELECT latitude, longitude FROM complete_contact_tracking "
                    f"WHERE {where} AND latitude IS NOT NULL AND longitude IS NOT NULL "
                    "AND NOT (latitude = 0 AND longitude = 0) "
                    "ORDER BY last_heard DESC LIMIT 1",
                    (arg,),
                ).fetchone()
            finally:
                conn.close()
            if row and abs(row[0]) <= 90 and abs(row[1]) <= 180:
                place = (float(row[0]), float(row[1]))
        except Exception as e:  # missing db, locked, schema change: just no position
            log.debug(f"BusBot position lookup failed: {e}")
        self._places[cache_key] = (time.time(), place)
        if len(self._places) > 2000:
            self._places.pop(next(iter(self._places)))
        return place

    def _post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    @staticmethod
    def _bytes(s: str) -> int:
        return len(s.encode("utf-8"))

    def _split(self, text: str, limit: int) -> list:
        """Split on line breaks to fit the mesh message limit, counted in UTF-8
        bytes (an emoji is 4 bytes on the air). Long lines break at spaces."""
        chunks, current = [], ""
        for line in text.split("\n"):
            while self._bytes(line) > limit:
                if current:
                    chunks.append(current)
                    current = ""
                # longest prefix that fits, preferring to break at a space
                cut = len(line)
                while cut > 0 and self._bytes(line[:cut]) > limit:
                    cut -= 1
                space = line.rfind(" ", 0, cut + 1)
                if space > 0:
                    cut = space
                cut = max(cut, 1)
                chunks.append(line[:cut].rstrip())
                line = line[cut:].lstrip()
            candidate = f"{current}\n{line}" if current else line
            if self._bytes(candidate) > limit:
                chunks.append(current)
                current = line
            else:
                current = candidate
        if current:
            chunks.append(current)
        return [c for c in chunks if c]

    async def execute(self, message: MeshMessage) -> bool:
        words = self.cleanup_message_for_matching(message).split()
        if not words:
            return False
        words[0] = self.word_map.get(words[0], words[0])
        payload = {
            "text": " ".join(words),
            "isDM": bool(message.is_dm),
            "name": message.sender_id,
            "pubKey": message.sender_pubkey,
            "words": self._words_for(message),
        }
        place = await asyncio.to_thread(self._lookup_place, message)
        if place:
            payload["lat"], payload["lon"] = place
        try:
            data = await asyncio.to_thread(self._post, payload)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            log.warning(f"BusBot unreachable at {self.url}: {e}")
            return await self.send_response(message, "Transit info is offline right now. Try again later.")

        reply = data.get("reply")
        if not reply:
            return False
        if message.is_dm:
            await ensure_dm_contact(self.bot, message.sender_pubkey, _refresh_state, log)
        limit = max(40, int(self.get_max_message_length(message)))
        chunks = self._split(reply, limit)
        if len(chunks) == 1:
            return await self.send_response(message, chunks[0])
        return await self.send_response_chunked(message, chunks)
