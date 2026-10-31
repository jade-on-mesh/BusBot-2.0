#!/usr/bin/env python3
"""
BusBot ride alarms for meshcore-bot.

BusBot (in API mode) decides when a rider's `watch` or `commute` alarm is
due and queues the DM. This service collects those DMs from BusBot's API
every few seconds and sends them with meshcore-bot's own send_dm.

Install: copy into meshcore-bot's local/service_plugins/ folder, then add to
local/config.ini and restart meshcore-bot:

    [BusBot_Alarms]
    enabled = true
    # url = http://127.0.0.1:8787
    # interval = 20
"""

import asyncio
import json
import logging
import urllib.request

from modules.service_plugins.base_service import BaseServicePlugin

log = logging.getLogger("busbot_alarms")
MAX_DM_BYTES = 140


def split_bytes(text: str, limit: int = MAX_DM_BYTES) -> list:
    """Split on line breaks (then spaces) so each DM fits the radio limit,
    counted in UTF-8 bytes since emoji are 4 bytes on the air."""
    size = lambda s: len(s.encode("utf-8"))
    chunks, current = [], ""
    for line in text.split("\n"):
        while size(line) > limit:
            cut = len(line)
            while cut > 0 and size(line[:cut]) > limit:
                cut -= 1
            space = line.rfind(" ", 0, cut + 1)
            cut = space if space > 0 else max(cut, 1)
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:cut].rstrip())
            line = line[cut:].lstrip()
        candidate = f"{current}\n{line}" if current else line
        if size(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return [c for c in chunks if c]


class BusBotAlarmsService(BaseServicePlugin):
    config_section = "BusBot_Alarms"
    description = "Delivers BusBot ride alarms (watch, commute) as DMs"

    def __init__(self, bot):
        super().__init__(bot)
        cfg = bot.config
        base = cfg.get(self.config_section, "url", fallback="http://127.0.0.1:8787") if cfg.has_section(self.config_section) else "http://127.0.0.1:8787"
        self.url = base.rstrip("/") + "/outbox/claim"
        try:
            self.interval = max(5, cfg.getint(self.config_section, "interval", fallback=20))
        except Exception:
            self.interval = 20
        self._task = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("BusBot alarms service started")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        log.info("BusBot alarms service stopped")

    def _claim(self) -> list:
        req = urllib.request.Request(self.url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode()).get("messages", [])

    async def _deliver(self, dm: dict) -> None:
        cm = self.bot.command_manager
        chunks = split_bytes(dm.get("text", ""))
        # Try the rider's public key first, then their name.
        recipients = [r for r in (dm.get("pubKey"), dm.get("name")) if r]
        for recipient in recipients:
            sent_all = True
            for i, chunk in enumerate(chunks):
                if i:
                    await asyncio.sleep(1.5)
                if not await cm.send_dm(recipient, chunk, skip_user_rate_limit=True):
                    sent_all = False
                    break
            if sent_all:
                return
        log.warning(f"Couldn't deliver BusBot alarm to {dm.get('name') or dm.get('pubKey')}")

    async def _loop(self) -> None:
        while self._running:
            try:
                messages = await asyncio.to_thread(self._claim)
            except Exception as e:  # BusBot restarting or down: try again next round
                log.debug(f"BusBot outbox unavailable: {e}")
                messages = []
            for dm in messages:
                try:
                    await self._deliver(dm)
                except Exception as e:
                    log.warning(f"BusBot alarm delivery failed: {e}")
                await asyncio.sleep(1.5)
            await asyncio.sleep(self.interval)
