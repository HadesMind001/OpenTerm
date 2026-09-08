"""OANDA provider regressions — both were silent, long-lived failures.

  * websockets 14 renamed connect(extra_headers=) -> additional_headers=.
    The old kwarg raised TypeError on EVERY attempt; the backoff loop swallowed
    it and the UI showed a permanently red dot. These tests mock
    websockets.connect and pin the new spelling (pyproject requires >=14).
  * runtime.push_watched() excluded OandaProvider from its hard-coded trio,
    so `watched` was empty forever and run() slept — FX streaming advertised,
    never delivered. Push must reach EVERY provider in rt.providers.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

import openterm.providers.oanda as oanda_mod
from openterm.core.bus import EventBus
from openterm.core.events import Trade
from openterm.core.symbols import from_key
from openterm.providers.oanda import OandaProvider, parse_price
from openterm.runtime import Runtime

PRICE_MSG = json.dumps({
    "type": "PRICE", "instrument": "EUR_USD",
    "bids": [{"price": "1.10000"}], "asks": [{"price": "1.10010"}],
})


class _FakeWs:
    """Mimics what websockets.connect(...) returns when used as `async with`."""

    def __init__(self):
        self._first = True

    async def recv(self):
        if self._first:
            self._first = False
            return PRICE_MSG
        await asyncio.Event().wait()  # hang forever; the test cancels us
        raise AssertionError("unreachable")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_run_uses_additional_headers_not_extra(monkeypatch):
    captured: dict = {}

    # NOTE: plain def, NOT async — `async with websockets.connect(...)` needs
    # the return value to be the async context manager itself.
    def fake_connect(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return _FakeWs()

    monkeypatch.setattr(oanda_mod.websockets, "connect", fake_connect)

    async def scenario():
        http = httpx.AsyncClient()
        bus = EventBus()
        try:
            prov = OandaProvider(bus, http, token="tok-1", account="1234567890")
            await prov.set_watched([from_key("FX:EURUSD")])
            sub = bus.subscribe("tick:*", maxsize=10)

            async def supervised():
                # mirrors base._loop: run() RETURNS on a watched-set change
                # (set_watched already set the event above) and the outer loop
                # re-invokes it — first pass connects and bails, second stays
                # on the wire and delivers the price.
                while True:
                    await prov.run()

            task = asyncio.create_task(supervised())
            topic, event = await asyncio.wait_for(sub.queue.get(), timeout=5)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            return topic, event
        finally:
            await http.aclose()

    topic, trade = asyncio.run(scenario())
    assert "additional_headers" in captured, "websockets>=14 kwarg missing"
    assert "extra_headers" not in captured, "13.x spelling is back — TypeError factory"
    hdrs = dict(captured["additional_headers"])
    assert hdrs["Authorization"] == "Bearer tok-1"
    assert "EUR_USD" in captured["url"]
    assert topic == "tick:FX:EURUSD"
    assert isinstance(trade, Trade) and trade.price == pytest.approx(1.10005)


def test_parse_price_rejects_junk():
    assert parse_price({"type": "HEARTBEAT"}) is None
    assert parse_price({"type": "PRICE", "instrument": "EUR_USD",
                        "bids": [], "asks": []}) is None
    assert parse_price({"type": "PRICE", "instrument": "EUR_USD",
                        "bids": [{"price": "nan?"}], "asks": [{"price": "x"}]}) is None


def test_push_watched_reaches_oanda(tmp_path, monkeypatch):
    """The hard-coded (binance, yahoo, gnews) tuple excluded every other
    provider — OandaProvider never learned what to watch. A push must fan out
    across ALL of rt.providers, whoever they are."""
    monkeypatch.setenv("OT_CONFIG_PATH", str(tmp_path / "cfg.json"))
    rt = Runtime(db_path=tmp_path / "p.db", with_providers=False)
    oanda = OandaProvider(rt.bus, rt.http, token="t", account="1234567890")
    rt.providers.append(oanda)
    rt.with_providers = True  # allow the push (no real provider loops in tests)

    inst = from_key("FX:EURUSD")
    assert inst is not None
    rt._watch(inst.key, inst, "watchlist")

    async def scenario():
        await rt.push_watched()
        await rt.http.aclose()

    try:
        asyncio.run(scenario())
        assert "FX:EURUSD" in oanda.watched
        assert oanda._instruments() == ["EUR_USD"]
    finally:
        rt.store.close()
