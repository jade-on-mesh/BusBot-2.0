#!/usr/bin/env python3
"""
BusBot ride alarms and quiet-channel alert posts for meshcore-bot.

BusBot (in API mode) decides when a rider's `watch` or `commute` alarm is
due and queues the DM. This service collects those DMs from BusBot's API
every few seconds and sends them with meshcore-bot's own send_dm.

It also watches the BusBot channel: after `quiet_minutes` with no traffic
it asks BusBot for one active service alert and posts it there. BusBot
picks the alert, skips repeats for 24 h, and stays silent overnight.

Install: copy into meshcore-bot's local/service_plugins/ folder, then add to
local/config.ini and restart meshcore-bot:

    [BusBot_Alarms]
    enabled = true
    # url = http://127.0.0.1:8787
    # interval = 20
    # alert_posts = true
    # channel = #transit
    # quiet_minutes = 60
"""

import asyncio
import json
import logging
import time
import urllib.request

from modules.service_plugins.base_service import BaseServicePlugin

log = logging.getLogger("busbot_alarms")
MAX_DM_BYTES = 140

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
        sec = self.config_section
        get = lambda key, default: cfg.get(sec, key, fallback=default) if cfg.has_section(sec) else default
        self.base = str(get("url", "http://127.0.0.1:8787")).rstrip("/")
        self.url = self.base + "/outbox/claim"
        try:
            self.interval = max(5, int(get("interval", 20)))
        except Exception:
            self.interval = 20
        self.alert_posts = str(get("alert_posts", "true")).strip().lower() not in ("0", "false", "off", "no")
        self.channel = str(get("channel", "#transit")).strip()
        try:
            self.quiet_minutes = max(10, int(get("quiet_minutes", 60)))
        except Exception:
            self.quiet_minutes = 60
        self._task = None
        self._started = time.time()
        self._last_post = 0.0
        self._last_check = 0.0

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

    def _post_json(self, path: str) -> dict:
        req = urllib.request.Request(
            self.base + path, data=b"{}", headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())

    def _claim(self) -> list:
        return self._post_json("/outbox/claim").get("messages", [])

    async def _maybe_post_alert(self) -> None:
        """After quiet_minutes with no traffic on the channel, post one alert."""
        if not self.alert_posts:
            return
        now = time.time()
        activity = getattr(self.bot, "_busbot_channel_activity", {}) or {}
        key = self.channel.lower()
        last = max(activity.get(key, 0), self._started, self._last_post)
        if now - last < self.quiet_minutes * 60 or now - self._last_check < 300:
            return
        self._last_check = now
        data = await asyncio.to_thread(self._post_json, "/broadcast/next")
        # A long alert comes as two messages ("parts"); older BusBots send one "text".
        parts = data.get("parts") or ([data["text"]] if data.get("text") else [])
        if not parts:
            return
        sent = False
        for i, part in enumerate(parts):
            if i:
                await asyncio.sleep(2)
            if await self.bot.command_manager.send_channel_message(self.channel, part, skip_user_rate_limit=True):
                sent = True
        if sent:
            self._last_post = time.time()
            activity[key] = self._last_post
            log.info(f"Posted transit alert to {self.channel} ({len(parts)} message(s))")

    async def _deliver(self, dm: dict) -> None:
        cm = self.bot.command_manager
        await ensure_dm_contact(self.bot, dm.get("pubKey"), _refresh_state, log)
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
            try:
                await self._maybe_post_alert()
            except Exception as e:
                log.debug(f"BusBot alert post skipped: {e}")
            await asyncio.sleep(self.interval)
