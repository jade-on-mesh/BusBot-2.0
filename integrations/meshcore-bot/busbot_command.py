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
    # word riders type = word BusBot understands. Rename a word here if it
    # collides with another meshcore-bot command. "alerts" belongs to
    # meshcore-bot's own alert command, so riders type "busalerts [stop]".
    keywords = bus=bus, busalerts=alerts, fav=fav
"""

import asyncio
import json
import logging
import urllib.error
import urllib.request

from modules.commands.base_command import BaseCommand
from modules.models import MeshMessage

SECTION = "BusBot_Command"
log = logging.getLogger("busbot_command")


class BusBotCommand(BaseCommand):
    """King County Metro arrivals, alerts and favorite stops via BusBot."""

    name = "busbot"
    keywords = ["bus", "busalerts", "fav"]
    description = (
        "King County Metro arrivals and alerts. 'bus [stop]', 'bus [stop] [route]', "
        "'busalerts [stop]'. In DMs: 'fav add [stop]', 'fav'."
    )
    category = "info"
    short_description = "King County Metro arrivals and alerts"
    usage = "bus [stop] [route]"
    examples = ["bus 1120", "bus 1120 11", "bus 120 G Line", "busalerts 1120", "fav add 1120"]
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
        raw = self.get_config_value(SECTION, "keywords", fallback="bus=bus, busalerts=alerts, fav=fav")
        self.word_map = {}
        for pair in str(raw).split(","):
            if "=" in pair:
                said, means = (p.strip().lower() for p in pair.split("=", 1))
                if said and means:
                    self.word_map[said] = means
        self.keywords = list(self.word_map) or ["bus"]

    def can_execute(self, message: MeshMessage, skip_channel_check: bool = False) -> bool:
        if not self.busbot_enabled:
            return False
        return super().can_execute(message)

    def matches_keyword(self, message: MeshMessage) -> bool:
        # First word only, so chatter like "busy" or "alerts are annoying" in
        # a channel only triggers when it's actually "alerts [stop]".
        words = self.cleanup_message_for_matching(message).split()
        if not words or words[0] not in self.word_map:
            return False
        means = self.word_map[words[0]]
        if means == "fav":
            return bool(message.is_dm)
        return len(words) == 1 or words[1][:1].isalnum()

    def _post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def _split(self, text: str, limit: int) -> list:
        """Split on line breaks to fit the mesh message limit, hard-splitting long lines."""
        chunks, current = [], ""
        for line in text.split("\n"):
            while len(line) > limit:
                if current:
                    chunks.append(current)
                    current = ""
                cut = line.rfind(" ", 0, limit + 1)
                if cut <= 0:
                    cut = limit
                chunks.append(line[:cut].rstrip())
                line = line[cut:].lstrip()
            candidate = f"{current}\n{line}" if current else line
            if len(candidate) > limit:
                chunks.append(current)
                current = line
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks

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
        }
        try:
            data = await asyncio.to_thread(self._post, payload)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            log.warning(f"BusBot unreachable at {self.url}: {e}")
            return await self.send_response(message, "Transit info is offline right now. Try again later.")

        reply = data.get("reply")
        if not reply:
            return False
        limit = max(40, int(self.get_max_message_length(message)))
        chunks = self._split(reply, limit)
        if len(chunks) == 1:
            return await self.send_response(message, chunks[0])
        return await self.send_response_chunked(message, chunks)
