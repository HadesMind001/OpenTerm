from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import Trade


def trade(price: float) -> Trade:
    return Trade(symbol_key="CRYPTO:BTCUSDT", price=price, size=1.0,
                 ts=datetime(2026, 1, 1, tzinfo=timezone.utc))


async def test_publish_subscribe_exact():
    bus = EventBus()
    sub = bus.subscribe("tick:CRYPTO:BTCUSDT")
    bus.publish("tick:CRYPTO:BTCUSDT", trade(1.0))
    topic, ev = await bus.get(sub)
    assert topic == "tick:CRYPTO:BTCUSDT"
    assert ev.price == 1.0


async def test_wildcard_pattern():
    bus = EventBus()
    sub = bus.subscribe("tick:*")
    bus.publish("tick:EQUITY:AAPL", trade(2.0))
    topic, _ = await bus.get(sub)
    assert topic == "tick:EQUITY:AAPL"


async def test_no_match_no_delivery():
    bus = EventBus()
    sub = bus.subscribe("quote:*")
    bus.publish("tick:CRYPTO:BTCUSDT", trade(1.0))
    assert bus.get_nowait(sub) is None


async def test_overflow_drops_oldest():
    bus = EventBus()
    sub = bus.subscribe("tick:*", maxsize=1)
    bus.publish("tick:X", trade(1.0))
    bus.publish("tick:X", trade(2.0))
    bus.publish("tick:X", trade(3.0))
    assert sub.dropped == 2
    _, ev = await bus.get(sub)
    assert ev.price == 3.0


async def test_unsubscribe_stops_delivery():
    bus = EventBus()
    sub = bus.subscribe("*")
    bus.unsubscribe(sub)
    bus.publish("tick:X", trade(1.0))
    assert bus.get_nowait(sub) is None
