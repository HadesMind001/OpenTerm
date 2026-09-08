"""OANDA practice-stream FX prices.

Practice (demo) environment only — the stream host is hardcoded to
stream-fxpractice. Pointing this at live money is out of scope for a terminal
whose "broker" is paper-only.

HISTORY, because this file broke twice and both ways were silent:
  1. websockets 14 renamed ``connect(extra_headers=...)`` to
     ``additional_headers=``. The old call raised TypeError on every attempt;
     the provider loop backoff caught it, and the UI just showed a permanently
     red dot nobody connected to the rename. pyproject now pins
     ``websockets>=14`` — do not "fix" this back for 13.x.
  2. runtime.push_watched() used to exclude OandaProvider, so ``watched`` was
     empty forever and run() slept a year. That is fixed in runtime, but the
     sleep-and-return here was also wrong (it slept *inside* run(), so a later
     set_watched never woke it). Now: if there is nothing to watch, return
     immediately and let the base loop re-invoke with a fresh instrument list.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import websockets

from ..core.events import Trade
from .base import Provider

log = logging.getLogger(__name__)

PRACTICE_STREAM = (
    "wss://stream-fxpractice.oanda.com/v3/accounts/{account}/pricing/stream"
)


def parse_price(msg: dict) -> tuple[str, float] | None:
    """Extract (instrument, mid price) from an OANDA pricing message."""
    if msg.get("type") != "PRICE":
        return None
    instrument = msg.get("instrument")
    bids = msg.get("bids") or []
    asks = msg.get("asks") or []
    if not instrument or not bids or not asks:
        return None
    try:
        bid = float(bids[0]["price"])
        ask = float(asks[0]["price"])
    except (KeyError, TypeError, ValueError, IndexError):
        # OANDA sends HEARTBEAT and other non-price frames; malformed or
        # partial book frames should not nuke the stream.
        return None
    return instrument, round((bid + ask) / 2, 6)


class OandaProvider(Provider):
    name = "oanda"
    capabilities = frozenset({"trades"})
    poll_interval = None
    # Re-check the watched set at most this often when idle. run() returning
    # immediately on "no instruments" + base-loop re-invocation would busy-
    # spin, so idle returns sleep here first.
    idle_wait = 15.0

    def __init__(self, *args, token: str = "", account: str = "", **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.token = token
        self.account = account
        self._resubscribe = asyncio.Event()

    def _instruments(self) -> list[str]:
        return [
            i.oanda
            for i in self.watched.values()
            if i.asset_class == "FX" and i.oanda
        ]

    async def on_watched_changed(self) -> None:
        # Same Event pattern as BinanceProvider: set_watched is called from
        # OUTSIDE run()'s task (via runtime.push_watched), so you cannot raise
        # into the stream from here. Flip the event; run() races on it and
        # returns for a reconnect with the new instrument list.
        self._resubscribe.set()

    async def run(self) -> None:
        instruments = self._instruments()
        if not instruments:
            # Nothing to watch: wait for the first set_watched instead of
            # sleeping blind (and give the base loop a bounded idle poll as
            # a belt-and-braces fallback).
            try:
                await asyncio.wait_for(self._resubscribe.wait(), timeout=self.idle_wait)
            except TimeoutError:
                pass
            self._resubscribe.clear()
            return
        url = PRACTICE_STREAM.format(account=self.account)
        headers = [
            ("Authorization", f"Bearer {self.token}"),
            ("Accept-Datetime-Format", "RFC3339"),
        ]
        # additional_headers (websockets >= 14). See module docstring before
        # "correcting" this back to extra_headers.
        async with websockets.connect(
            f"{url}?instruments={','.join(instruments)}",
            additional_headers=headers,
            open_timeout=10,
            ping_interval=20,
            max_size=2**20,
        ) as ws:
            self.set_status(True)
            resub = asyncio.ensure_future(self._resubscribe.wait())
            msgs = asyncio.ensure_future(ws.recv())
            try:
                # Race stream messages against "watched set changed" — without
                # this, adding EUR_USD to the watchlist does nothing until the
                # next OANDA message happens to arrive (which, pre-change, was
                # never, because the symbol was not in the subscribe list).
                while True:
                    done, _pending = await asyncio.wait(
                        {resub, msgs}, timeout=None, return_when=asyncio.FIRST_COMPLETED
                    )
                    if resub in done:
                        break
                    if msgs in done:
                        raw = msgs.result()
                        msgs = asyncio.ensure_future(ws.recv())
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        parsed = parse_price(msg)
                        if not parsed:
                            continue
                        instrument, mid = parsed
                        key = f"FX:{instrument.replace('_', '')}"
                        self.bus.publish(
                            f"tick:{key}",
                            Trade(symbol_key=key, feed="OANDA",
                                  ts=datetime.now(timezone.utc),
                                  price=mid, size=0.0),
                        )
            finally:
                for t in (resub, msgs):
                    t.cancel()
                self._resubscribe.clear()
