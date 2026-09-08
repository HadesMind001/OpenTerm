"""Broker (paper engine) regressions: ghost orders, avg-price math, cash seed.

  * Market-without-price used to INSERT the order row first and raise after —
    the DB kept a "working" market order that _evaluate never touches (it only
    handles limit/stop kinds): a ghost haunting the blotter forever.
  * Weighted avg fill bumped filled_qty BEFORE weighting the previous average
    by it, so any partial fill double-counted. Full fills only today — but the
    math must be right anyway.
  * __init__ accepted starting_cash and then seeded a hardcoded 100k anyway.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import Trade
from openterm.core.store import Store
from openterm.services.broker import Broker, OrderError
from openterm.services.marketstate import MarketState

KEY = "CRYPTO:BTCUSDT"


def tick(px: float) -> Trade:
    return Trade(symbol_key=KEY, price=px, size=1.0, ts=datetime.now(timezone.utc))


@pytest.fixture()
def env(tmp_path):
    store = Store(tmp_path / "b.db")
    ms = MarketState()
    return store, ms, Broker(EventBus(), store, ms)


def test_market_order_without_price_leaves_no_ghost(env, tmp_path):
    store, _ms, broker = env
    with pytest.raises(OrderError):
        broker.submit(KEY, "buy", "market", 1.0)
    # the whole point: NOT a single row survives the failed submit
    assert store.get_orders() == []
    assert broker.orders == {}
    assert store.get_fills() == []


def test_partial_fill_averages_by_previous_weight(env):
    _store, _ms, broker = env
    row = broker.submit(KEY, "buy", "limit", 2.0, limit_price=30_000.0)
    oid = row["id"]
    # simulate an earlier partial: 1 @ 100 already booked (bypass _execute so
    # only the avg-weighting line is under test)
    row["filled_qty"] = 1.0
    row["avg_fill"] = 100.0

    broker._execute(row, 200.0)
    slip = 200.0 * (1 + broker.slippage_bps * 1e-4)  # buy slips upward
    # correct weighting: (100*1 + slip*1) / 2 — the old bug computed
    # (100*2 + slip*1) / 3 ≈ 166.7
    assert abs(row["avg_fill"] - (100.0 + slip) / 2) < 1e-6
    assert row["filled_qty"] == 2.0
    db_row = next(r for r in broker.store.get_orders() if r["id"] == oid)
    assert db_row["status"] == "filled"
    assert abs(db_row["avg_fill"] - row["avg_fill"]) < 1e-6


def test_starting_cash_is_respected(tmp_path):
    store = Store(tmp_path / "sc.db")
    broker = Broker(EventBus(), store, MarketState(), starting_cash=250.0)
    assert broker.cash == 250.0
    assert broker.portfolio()["cash"] == 250.0
    # reload must NOT re-seed: deposits are the ledger, not a constant
    broker2 = Broker(EventBus(), Store(tmp_path / "sc.db"), MarketState(),
                     starting_cash=999_999.0)
    assert broker2.cash == 250.0
