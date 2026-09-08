from datetime import datetime, timezone

from openterm.core.events import Depth, DepthLevel, Quote, StatsSnapshot, Trade
from openterm.services.marketstate import MarketState


def ts():
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_trade_updates_last():
    ms = MarketState()
    ms.update_stats(StatsSnapshot(symbol_key="X", ts=ts(), last=100.0,
                                  prev_close=90.0))
    ms.update_trade(Trade(symbol_key="X", price=101.0, size=1, ts=ts()))
    e = ms.get("X")
    assert e["last"] == 101.0
    assert e["change_pct"] == pytest_approx(12.2222)


def test_quote_and_depth():
    ms = MarketState()
    ms.update_quote(Quote(symbol_key="X", bid=99.0, ask=101.0, ts=ts()))
    assert ms.get("X")["bid"] == 99.0
    ms.update_depth(Depth(symbol_key="X", bids=[DepthLevel(price=99, size=5)],
                          asks=[DepthLevel(price=101, size=3)]))
    assert ms.depth("X").bids[0].size == 5


def test_snapshot_skips_empty_via_helper():
    ms = MarketState()
    ms.update_trade(Trade(symbol_key="Y", price=10.0, ts=ts()))
    snap = ms.snapshot()
    assert "Y" in snap


def pytest_approx(value, tol=0.01):
    class _A:
        def __eq__(self, other):
            return abs(other - value) < tol

    return _A()
