from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app
from openterm.core.bus import EventBus
from openterm.core.events import Trade
from openterm.core.store import Store
from openterm.services.broker import Broker
from openterm.services.marketstate import MarketState


def test_second_sell_cancels_instead_of_shorting(tmp_path):
    bus = EventBus()
    ms = MarketState()
    store = Store(tmp_path / "t.db")
    broker = Broker(bus, store, ms)

    def tick(px):
        return Trade(symbol_key="CRYPTO:BTCUSDT", price=px, size=1.0,
                     ts=datetime.now(timezone.utc))

    ms.update_trade(tick(100.0))
    broker.submit("CRYPTO:BTCUSDT", "buy", "market", 1.0)
    assert broker.positions["CRYPTO:BTCUSDT"]["qty"] == 1.0

    s1 = broker.submit("CRYPTO:BTCUSDT", "sell", "limit", 1.0, limit_price=101.0)
    s2 = broker.submit("CRYPTO:BTCUSDT", "sell", "limit", 1.0, limit_price=101.0)
    broker.on_tick(tick(101.0))

    pos = broker.positions["CRYPTO:BTCUSDT"]
    assert pos["qty"] == 0.0, "must never go short"
    assert s1["status"] == "filled"
    assert s2["status"] == "canceled"


def test_flatten_shorts_on_reload(tmp_path):
    path = tmp_path / "shorts.db"
    bus = EventBus()
    store = Store(path)
    ms = MarketState()
    ms.update_trade(Trade(symbol_key="X", price=50.0,
                          ts=datetime.now(timezone.utc)))
    b = Broker(bus, store, ms)
    b.submit("X", "buy", "market", 1.0)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO fills(order_id, symbol_key, side, qty, price, fee, ts) "
        "VALUES (0, 'X', 'sell', 3, 50, 0, 0)"
    )
    conn.commit()
    conn.close()

    b2 = Broker(EventBus(), Store(path), ms)
    assert b2.positions["X"]["qty"] == 0.0, "legacy short must flatten on load"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OT_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


def test_keys_menu_roundtrip(client, tmp_path):
    r = client.post("/api/settings/keys", json={
        "finnhub_key": "abc123",
        "fred_key": "",
        "polygon_key": "poly",
    })
    assert r.status_code == 200
    body = r.json()
    assert set(body["saved"]) >= {"finnhub_key", "polygon_key"}
    assert body["available"]["finnhub"] is True
    assert body["available"]["polygon"] is True
    assert body["available"]["fred"] is False

    cfg = tmp_path / "cfg" / "config.json"
    data = json.loads(cfg.read_text())
    assert data["finnhub_key"] == "abc123"

    clear = client.post("/api/settings/keys", json={"polygon_key": ""})
    assert clear.json()["available"]["polygon"] is False
    data = json.loads(cfg.read_text())
    assert "polygon_key" not in data


def test_settings_note_live_apply(client):
    s = client.get("/api/settings").json()
    assert "no restart" in s["note"] or "live" in s["note"]
