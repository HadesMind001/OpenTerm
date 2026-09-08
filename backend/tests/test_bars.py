from __future__ import annotations

from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import Bar, Trade
from openterm.services.bars import BarBuilder


def make_builder():
    bus = EventBus()
    return bus, BarBuilder(bus)


def tick(minute: int, second: int, price: float):
    ts = datetime(2026, 1, 1, 12, minute, second, tzinfo=timezone.utc)
    return Trade(symbol_key="CRYPTO:BTCUSDT", price=price, size=1.0, ts=ts)


async def collect(bus, pattern="bar:*"):
    sub = bus.subscribe(pattern)
    return sub


async def test_aggregates_within_bar():
    bus, builder = make_builder()
    sub = await collect(bus)
    builder.update(tick(0, 5, 100.0))
    builder.update(tick(0, 20, 110.0))
    builder.update(tick(0, 40, 95.0))
    drained = []
    while True:
        item = bus.get_nowait(sub)
        if not item:
            break
        drained.append(item[1])
    partial_1m = [b for b in drained if b.interval == "1m" and not b.closed]
    assert partial_1m[-1].o == 100.0
    assert partial_1m[-1].h == 110.0
    assert partial_1m[-1].l == 95.0
    assert partial_1m[-1].c == 95.0
    assert partial_1m[-1].v == 3.0


async def test_closes_bar_on_new_bucket():
    bus, builder = make_builder()
    sub = await collect(bus)
    builder.update(tick(0, 10, 100.0))
    builder.update(tick(1, 10, 105.0))
    closed = []
    while True:
        item = bus.get_nowait(sub)
        if not item:
            break
        if item[1].interval == "1m" and item[1].closed:
            closed.append(item[1])
    assert len(closed) == 1
    assert closed[0].o == 100.0 and closed[0].c == 100.0


async def test_creates_all_intervals():
    bus, builder = make_builder()
    sub = await collect(bus)
    builder.update(tick(0, 30, 50.0))
    intervals = set()
    while True:
        item = bus.get_nowait(sub)
        if not item:
            break
        intervals.add(item[1].interval)
    assert {"1m", "5m", "15m", "1h", "4h", "1d"} <= intervals


async def test_rollup_merges_ohlcv():
    """The old version tested BarBuilder.rollup(), a dead parallel design.
    The real rollup path is update(): every trade advances every interval.
    This now tests what actually ships: trades in minutes 0-4, then a trade
    in minute 5 closing the 5m bucket with merged OHLCV."""
    bus, builder = make_builder()
    sub = await collect(bus)
    builder.update(tick(0, 10, 100.0))
    builder.update(tick(2, 30, 130.0))
    builder.update(tick(4, 50, 90.0))
    builder.update(tick(5, 10, 110.0))  # crosses the 12:05 5m boundary
    closed_5m = []
    while True:
        item = bus.get_nowait(sub)
        if not item:
            break
        if item[1].interval == "5m" and item[1].closed:
            closed_5m.append(item[1])
    assert len(closed_5m) == 1
    b = closed_5m[0]
    assert b.o == 100.0 and b.h == 130.0 and b.l == 90.0 and b.c == 90.0
    assert b.v == 3.0  # the fourth (minute 5) trade already opens the new bucket


def test_seed_only_continues_current_bucket():
    """seed() must adopt a persisted bar ONLY if its bucket is still open
    right now; a bar from an older bucket must not resurrect stale state
    (which would emit a duplicate close on the next tick)."""
    import time

    bus, builder = make_builder()
    now = int(time.time())
    cur_bucket = now // 300 * 300
    row = {"ts": cur_bucket, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0}
    builder.seed("CRYPTO:BTCUSDT", "5m", row)
    assert builder.current[("CRYPTO:BTCUSDT", "5m")]["h"] == 2.0

    stale = dict(row, ts=cur_bucket - 300)
    builder2 = BarBuilder(EventBus())
    builder2.seed("CRYPTO:BTCUSDT", "5m", stale)
    assert ("CRYPTO:BTCUSDT", "5m") not in builder2.current
