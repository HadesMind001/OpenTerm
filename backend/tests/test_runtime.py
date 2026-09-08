import asyncio
from datetime import datetime, timezone

import pytest

from openterm.core.events import Bar, StatsSnapshot, Trade
from openterm.runtime import Runtime


def make_runtime(tmp_path):
    return Runtime(db_path=tmp_path / "t.db", with_providers=False)


def tick(price: float, minute: int = 0) -> Trade:
    ts = datetime(2026, 1, 1, 12, minute, tzinfo=timezone.utc)
    return Trade(symbol_key="CRYPTO:BTCUSDT", price=price, size=1.0, ts=ts)


def test_dispatch_routes_tick_to_state_and_bars(tmp_path):
    rt = make_runtime(tmp_path)
    rt.handle("tick:CRYPTO:BTCUSDT", tick(100.0))
    assert rt.market_state.get("CRYPTO:BTCUSDT")["last"] == 100.0
    assert ("CRYPTO:BTCUSDT", "1m") in rt.bar_builder.current


def test_closed_bar_persists(tmp_path):
    rt = make_runtime(tmp_path)
    bar = Bar(symbol_key="CRYPTO:BTCUSDT", interval="1m", feed="BINANCE",
              ts=1767262800, o=1, h=2, l=0.5, c=1.5, v=9, closed=True)
    rt.handle("bar:CRYPTO:BTCUSDT:1m", bar)
    rt.store.flush()
    stored = rt.store.get_bars("CRYPTO:BTCUSDT", "1m")
    assert len(stored) == 1 and stored[0]["c"] == 1.5


def test_news_buffered_by_symbol(tmp_path):
    from openterm.core.events import NewsItem

    rt = make_runtime(tmp_path)
    item = NewsItem(symbol_key="", feed="GNEWS", headline="Markets rally",
                    published=datetime.now(timezone.utc))
    rt.handle("news:MARKET", item)
    assert len(rt.news["MARKET"]) == 1


def test_watch_and_unwatch(tmp_path):
    rt = make_runtime(tmp_path)
    rt.watch(["EQUITY:AAPL"], "detail")
    assert "EQUITY:AAPL" in rt._watched
    rt.unwatch(["EQUITY:AAPL"], "watchlist")
    assert "EQUITY:AAPL" in rt._watched
    rt.unwatch(["EQUITY:AAPL"], "detail")
    assert "EQUITY:AAPL" not in rt._watched


async def test_start_stop_lifecycle(tmp_path):
    rt = make_runtime(tmp_path)
    await rt.start()
    await asyncio.sleep(0)
    assert len(rt._dispatch_tasks) == 16
    await rt.stop()


async def test_status_tracking(tmp_path):
    rt = make_runtime(tmp_path)
    from openterm.core.events import ProviderStatus

    rt.handle("status:binance", ProviderStatus(name="binance", connected=True))
    assert rt.statuses()["binance"] is True
