from __future__ import annotations

from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import AlertEvent, Bar, Trade
from openterm.core.store import Store
from openterm.services.alerts import AlertEngine, rsi_series


def ts():
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


def tick(price: float, key: str = "CRYPTO:BTCUSDT") -> Trade:
    return Trade(symbol_key=key, price=price, size=1.0, ts=ts())


@pytest.fixture()
def eng(tmp_path):
    bus = EventBus()
    sub = bus.subscribe("alert:*")
    return bus, AlertEngine(bus, Store(tmp_path / "t.db")), sub


def drain(bus, sub):
    out = []
    while True:
        item = bus.get_nowait(sub)
        if not item:
            break
        out.append(item[1])
    return out


def test_above_triggers_and_deactivates(eng):
    bus, e, sub = eng
    rule = e.create("CRYPTO:BTCUSDT", "above", 100.0, ref_price=None)
    e.on_trade(tick(99.0))
    assert drain(bus, sub) == []
    e.on_trade(tick(101.0))
    events = drain(bus, sub)
    assert len(events) == 1
    assert events[0].kind == "above"
    assert not rule["active"]
    e.on_trade(tick(102.0))
    assert drain(bus, sub) == []


def test_below_triggers(eng):
    bus, e, sub = eng
    e.create("CRYPTO:BTCUSDT", "below", 90.0, None)
    e.on_trade(tick(95.0))
    e.on_trade(tick(89.0))
    fired = drain(bus, sub)
    assert len(fired) == 1 and fired[0].symbol_key == "CRYPTO:BTCUSDT"


def test_pct_move_captures_ref_then_fires(eng):
    bus, e, sub = eng
    e.create("CRYPTO:BTCUSDT", "pct_up", 5.0, ref_price=100.0)
    e.on_trade(tick(103.0))
    assert drain(bus, sub) == []
    e.on_trade(tick(105.5))
    assert len(drain(bus, sub)) == 1


def test_cooldown_blocks_recurring_refire(eng):
    bus, e, sub = eng
    e.create("CRYPTO:BTCUSDT", "above", 50.0, None, one_shot=False, cooldown=3600)
    e.on_trade(tick(60.0))
    first = drain(bus, sub)
    assert len(first) == 1
    e.on_trade(tick(61.0))
    assert drain(bus, sub) == []


def test_snooze_blocks_fire(eng):
    bus, e, sub = eng
    rule = e.create("CRYPTO:BTCUSDT", "above", 50.0, None, one_shot=False)
    e.snooze(rule["id"], 3600)
    e.on_trade(tick(60.0))
    assert drain(bus, sub) == []


def test_rsi_alert_fires_on_closed_bars(eng):
    bus, e, sub = eng
    e.create("CRYPTO:BTCUSDT", "rsi_above", 70.0, None)
    px = 100.0
    for i in range(30):
        px *= 1.01
        bar = Bar(symbol_key="CRYPTO:BTCUSDT", interval="1m", feed="AGG",
                  ts=1767262800 + i * 60, o=px, h=px, l=px, c=px, v=10,
                  closed=True)
        e.on_bar(bar)
        fired = drain(bus, sub)
        if fired:
            assert fired[0].kind == "rsi_above"
            return
    pytest.fail("rsi alert never fired on a strong uptrend")


def test_vol_spike_alert(eng):
    bus, e, sub = eng
    e.create("CRYPTO:BTCUSDT", "vol_spike", 3.0, None)
    for i in range(10):
        e.on_bar(Bar(symbol_key="CRYPTO:BTCUSDT", interval="1m", feed="AGG",
                     ts=i * 60, o=1, h=1, l=1, c=1, v=10, closed=True))
        drain(bus, sub)
    e.on_bar(Bar(symbol_key="CRYPTO:BTCUSDT", interval="1m", feed="AGG",
                 ts=600, o=1, h=1, l=1, c=1, v=100, closed=True))
    fired = drain(bus, sub)
    assert len(fired) == 1 and "avg vol" in fired[0].message


def test_rsi_series_math():
    up = [100 * (1.01 ** i) for i in range(20)]
    r = rsi_series(up)
    assert r is not None and r > 95
    assert rsi_series([1, 2, 3]) is None


def test_rules_persist_across_reload(tmp_path):
    store = Store(tmp_path / "t.db")
    bus = EventBus()
    e1 = AlertEngine(bus, store)
    e1.create("EQUITY:AAPL", "below", 200.0, None, one_shot=False)
    e2 = AlertEngine(EventBus(), store)
    assert len(e2.rules) == 1
