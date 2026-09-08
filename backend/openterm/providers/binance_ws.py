from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import websockets

from ..core.events import Depth, DepthLevel, StatsSnapshot, Trade
from .base import Provider

log = logging.getLogger(__name__)

WS_URL = "wss://stream.binance.com:9443/stream"
REST = "https://api.binance.com/api/v3"
# Max streams per SUBSCRIBE message (Binance hard-rejects 200+).
_SUBSCRIBE_CHUNK = 150


class BinanceProvider(Provider):
    name = "binance"
    capabilities = frozenset({"trades", "depth", "bars", "stats"})
    poll_interval = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._resubscribe = asyncio.Event()

    async def run(self) -> None:
        self._resubscribe.clear()
        streams = self._streams()
        if not streams:
            await self._resubscribe.wait()
            return
        await self._stats_loop_once()
        # Synchronous kick before the websocket connect: otherwise the first
        # stats snapshot only arrives 30s in, and every consumer that wants
        # prev_close/day-range pays a full cycle for no reason.
        stats_task = asyncio.create_task(self._stats_loop())
        try:
            async with websockets.connect(
                WS_URL, max_size=2**22, open_timeout=10, ping_interval=20
            ) as ws:
                self.set_status(True)
                # Binance rejects a SUBSCRIBE message with >200 streams and
                # (worse, historically) sometimes just ignores the overflow —
                # with trade+depth per symbol, that's 100 symbols before we
                # silently lose data. Chunk with unique ids; SUBSCRIBE is
                # additive server-side, so chunking is safe.
                for chunk_id, i in enumerate(
                    range(0, len(streams), _SUBSCRIBE_CHUNK), start=1
                ):
                    await ws.send(json.dumps({
                        "method": "SUBSCRIBE",
                        "params": streams[i:i + _SUBSCRIBE_CHUNK],
                        "id": chunk_id,
                    }))
                recv = asyncio.create_task(self._read(ws))
                resub = asyncio.create_task(self._resubscribe.wait())
                done, pending = await asyncio.wait(
                    {recv, resub}, return_when=asyncio.FIRST_COMPLETED
                )
                for t in pending:
                    t.cancel()
                if resub in done:
                    return
                exc = recv.exception() if recv in done else None
                if exc:
                    raise exc
        finally:
            stats_task.cancel()

    def _streams(self) -> list[str]:
        # @depth20@100ms is the PARTIAL BOOK stream: every message is a
        # self-contained top-20 snapshot, not a delta. That choice is the
        # whole depth strategy — the diff-depth stream is the one that
        # requires the classic REST-snapshot + update_id sequencing dance
        # (fetch snapshot, buffer deltas, drop every delta with
        # last_update_id <= the snapshot's, then require the next delta's
        # first_update_id to be exactly snapshot_final+1 or the gap means
        # the book is re-synced from scratch). Get that ordering wrong and
        # the ladder doesn't crash — it lies: a phantom level from a
        # superseded snapshot sits there looking plausible until someone
        # "trades" into it. We buy structural immunity instead: stateless
        # full snapshots mean out-of-order or dropped messages are at worst
        # one 100ms hop stale, never corrupted. Cost: 20 levels deep, no
        # more. If depth beyond top-20 is ever needed, build the delta
        # machinery properly — do NOT bolt it onto this handler.
        out = []
        for inst in self.watched.values():
            if not inst.binance:
                continue
            s = inst.binance.lower()
            out.append(f"{s}@trade")
            out.append(f"{s}@depth20@100ms")
        return out

    async def _read(self, ws) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            data = msg.get("data")
            if not data:
                continue
            etype = data.get("e") or ""
            stream = msg.get("stream", "")
            if etype == "trade":
                self._on_trade(data)
            elif "@depth20@" in stream:
                self._on_depth(stream.split("@")[0].upper(), data)

    def _on_trade(self, d: dict) -> None:
        key = f"CRYPTO:{d['s']}"
        ts = datetime.fromtimestamp(d["T"] / 1000, tz=timezone.utc)
        side = "sell" if d.get("m") else "buy"
        self.bus.publish(
            f"tick:{key}",
            Trade(symbol_key=key, feed="BINANCE", ts=ts,
                  price=float(d["p"]), size=float(d["q"]), side=side),
        )

    def _on_depth(self, pair: str, d: dict) -> None:
        bids_raw = d.get("bids") or []
        asks_raw = d.get("asks") or []
        key = f"CRYPTO:{pair}"
        depth = Depth(
            symbol_key=key,
            feed="BINANCE",
            bids=[DepthLevel(price=float(p), size=float(q)) for p, q in bids_raw[:20]],
            asks=[DepthLevel(price=float(p), size=float(q)) for p, q in asks_raw[:20]],
        )
        self.bus.publish(f"depth:{key}", depth)

    async def on_watched_changed(self) -> None:
        self._resubscribe.set()

    async def _stats_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                await self._stats_loop_once()
            except Exception:
                # Deliberately soft: 24hr stats are an enrichment poll. If it
                # fails, live trade/depth streams keep working and the next
                # tick lands in 30s anyway. Logged, never silent.
                log.debug("binance stats poll failed", exc_info=True)

    async def _stats_loop_once(self) -> None:
        symbols = [
            i.ticker for i in self.watched.values() if i.asset_class == "CRYPTO"
        ]
        if not symbols:
            return
        sym_json = json.dumps(symbols, separators=(",", ":"))
        resp = await self.http.get(
            f"{REST}/ticker/24hr", params={"symbols": sym_json}
        )
        resp.raise_for_status()
        for row in resp.json():
            key = f"CRYPTO:{row['symbol']}"
            last = float(row["lastPrice"])
            prev = float(row["prevClosePrice"]) if row.get("prevClosePrice") else None
            # "24hr" is a ROLLING window, not an exchange day: day_high/
            # day_low here are 24h extremes that slide continuously and never
            # "roll over" at any midnight. MarketState stores them verbatim
            # under those names — crypto has no session, so it's the closest
            # thing to a truth we have, but don't read these as calendar-day
            # stats. change is computed from prev rather than trusting
            # priceChangePercent so the value matches OUR (last-prev)/prev
            # definition (see MarketState invariants); Binance's own field is
            # the fallback when prevClosePrice is absent.
            change = (
                round((last - prev) / prev * 100, 4) if prev else float(
                    row.get("priceChangePercent") or 0.0
                )
            )
            self.bus.publish(
                f"stats:{key}",
                StatsSnapshot(
                    symbol_key=key,
                    feed="BINANCE",
                    last=last,
                    open=float(row.get("openPrice") or 0) or None,
                    prev_close=prev,
                    day_high=float(row["highPrice"]),
                    day_low=float(row["lowPrice"]),
                    volume=float(row["volume"]),
                    change_pct=change,
                ),
            )
        self.set_status(True)
