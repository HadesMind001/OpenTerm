from __future__ import annotations

from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import Trade
from openterm.core.store import Store
from openterm.services.broker import Broker, OrderError
from openterm.services.marketstate import MarketState


def ts():
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


def tick(price: float, key: str = "CRYPTO:BTCUSDT") -> Trade:
    return Trade(symbol_key=key, price=price, size=1.0, ts=ts())


@pytest.fixture()
def setup(tmp_path):
    bus = EventBus()
    store = Store(tmp_path / "t.db")
    ms = MarketState()
    ms.update_trade(tick(100.0))
    broker = Broker(bus, store, ms)
    return bus, store, ms, broker


def test_market_buy_fills_with_slippage_and_fee(setup):
    _, _, _, broker = setup
    order = broker.submit("CRYPTO:BTCUSDT", "buy", "market", 1.0)
    assert order["status"] == "filled"
    pos = broker.positions["CRYPTO:BTCUSDT"]
    assert pos["qty"] == 1.0
    assert pos["avg"] == pytest.approx(100.0 * (1 + 2e-4), rel=1e-4)
    assert broker.cash < 100_000.0


def test_limit_buy_fills_only_when_crossed(setup):
    _, _, ms, broker = setup
    order = broker.submit("CRYPTO:BTCUSDT", "buy", "limit", 1.0, limit_price=95.0)
    assert order["status"] == "working"
    broker.on_tick(tick(96.0))
    assert order["status"] == "working"
    broker.on_tick(tick(94.0))
    assert order["status"] == "filled"
    assert order["avg_fill"] == pytest.approx(94.0 * (1 + 2e-4), rel=1e-5)


def test_stop_buy_triggers_above_stop(setup):
    _, _, _, broker = setup
    order = broker.submit("CRYPTO:BTCUSDT", "buy", "stop", 1.0, stop_price=105.0)
    broker.on_tick(tick(104.0))
    assert order["status"] == "working"
    broker.on_tick(tick(105.5))
    assert order["status"] == "filled"


def test_stop_limit_sell_flow(setup):
    bus, _, ms, broker = setup
    fills_sub = bus.subscribe("fill:*")
    broker.submit("CRYPTO:BTCUSDT", "buy", "market", 2.0)
    order = broker.submit(
        "CRYPTO:BTCUSDT", "sell", "stop_limit", 2.0,
        limit_price=98.5, stop_price=99.0,
    )
    broker.on_tick(tick(100.0))
    assert order["status"] == "working"
    broker.on_tick(tick(98.5))
    assert order["status"] == "filled"
    events = []
    while True:
        item = bus.get_nowait(fills_sub)
        if not item:
            break
        events.append(item[1])
    assert len(events) == 2
    assert {e.side for e in events} == {"buy", "sell"}


def test_sell_more_than_held_rejected(setup):
    _, _, _, broker = setup
    with pytest.raises(OrderError):
        broker.submit("CRYPTO:BTCUSDT", "sell", "market", 5.0)


def test_cancel_and_amend(setup):
    _, _, _, broker = setup
    o = broker.submit("CRYPTO:BTCUSDT", "buy", "limit", 1.0, limit_price=50.0)
    amended = broker.amend(o["id"], qty=3.0, limit_price=51.0)
    assert amended["qty"] == 3.0 and amended["limit_price"] == 51.0
    assert broker.cancel(o["id"])
    broker.on_tick(tick(40.0))
    assert o["status"] == "canceled"
    assert not broker.cancel(o["id"])


def test_realized_pnl_on_sell(setup):
    _, _, _, broker = setup
    broker.submit("CRYPTO:BTCUSDT", "buy", "limit", 1.0, limit_price=100.0)
    broker.on_tick(tick(100.0))
    broker.submit("CRYPTO:BTCUSDT", "sell", "limit", 1.0, limit_price=110.0)
    broker.on_tick(tick(110.0))
    pos = broker.positions["CRYPTO:BTCUSDT"]
    assert pos["qty"] == 0.0
    assert pos["realized"] > 9.0
    trades = broker._closed_trades()
    assert len(trades) == 1 and trades[0]["pnl"] > 9.0


def test_persistence_across_reload(tmp_path):
    bus = EventBus()
    store = Store(tmp_path / "t.db")
    ms = MarketState()
    ms.update_trade(tick(100.0))
    b1 = Broker(bus, store, ms)
    b1.submit("CRYPTO:BTCUSDT", "buy", "market", 2.0)
    b1.submit("EQUITY:AAPL", "buy", "limit", 1.0, limit_price=90.0)

    b2 = Broker(EventBus(), store, ms)
    assert b2.positions["CRYPTO:BTCUSDT"]["qty"] == 2.0
    assert any(o["otype"] == "limit" for o in b2.orders.values())
    equity_before = b1.portfolio()["equity"]
    assert b2.portfolio()["equity"] == pytest.approx(equity_before, rel=1e-6)


def test_analytics_stats_shape(tmp_path):
    bus = EventBus()
    store = Store(tmp_path / "t.db")
    ms = MarketState()
    ms.update_trade(tick(100.0))
    b = Broker(bus, store, ms)
    b.submit("CRYPTO:BTCUSDT", "buy", "market", 1.0)
    ms.update_trade(tick(120.0))
    b.on_tick(tick(120.0))
    b.submit("CRYPTO:BTCUSDT", "sell", "market", 1.0)
    a = b.analytics()
    assert a["win_rate"] == 100.0
    assert a["profit_factor"] is None or a["profit_factor"] >= 1
    assert isinstance(a["trades"], list) and len(a["trades"]) == 1


async def test_runtime_routes_ticks_to_broker(tmp_path):
    from openterm.runtime import Runtime

    rt = Runtime(db_path=tmp_path / "t.db", with_providers=False)
    await rt.start()
    try:
        rt.handle("tick:CRYPTO:BTCUSDT", tick(50.0))
        order = rt.broker.submit("CRYPTO:BTCUSDT", "buy", "market", 1.0)
        assert order["status"] == "filled"
    finally:
        await rt.stop()
