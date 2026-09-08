from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app
from openterm.providers.alpaca import (
    AlpacaClient,
    normalize_order,
    order_payload,
    portfolio_from,
    to_alpaca_symbol,
)


# ---------------------------------------------------------------- mapping


def test_to_alpaca_symbol_equities_only():
    assert to_alpaca_symbol("EQUITY:AAPL") == "AAPL"
    assert to_alpaca_symbol("EQUITY:MSFT") == "MSFT"
    assert to_alpaca_symbol("CRYPTO:BTCUSDT") is None
    assert to_alpaca_symbol("FX:EURUSD") is None


def test_order_payload_market():
    body = order_payload("EQUITY:AAPL", "buy", "market", 10)
    assert body == {
        "symbol": "AAPL",
        "qty": "10",
        "side": "buy",
        "type": "market",
        "time_in_force": "gtc",
    }


def test_order_payload_limit_and_stop():
    body = order_payload(
        "EQUITY:TSLA", "sell", "limit", 2.5, limit_price=244.5, tif="day"
    )
    assert body["limit_price"] == "244.5"
    assert body["time_in_force"] == "day"
    assert "stop_price" not in body

    stop = order_payload("EQUITY:AAPL", "buy", "stop", 1, stop_price=199.0)
    assert stop["stop_price"] == "199"
    assert "limit_price" not in stop

    sl = order_payload(
        "EQUITY:AAPL", "buy", "stop_limit", 1,
        limit_price=201.0, stop_price=199.0,
    )
    assert sl["limit_price"] == "201" and sl["stop_price"] == "199"


def test_order_payload_rejects_bad_input():
    with pytest.raises(ValueError):
        order_payload("CRYPTO:BTCUSDT", "buy", "market", 1)
    with pytest.raises(ValueError):
        order_payload("EQUITY:AAPL", "buy", "limit", 1)  # missing limit price
    with pytest.raises(ValueError):
        order_payload("EQUITY:AAPL", "buy", "fling", 1)


def test_portfolio_from_maps_account_and_positions():
    account = {"cash": "95000.50", "equity": "100432.10"}
    positions = [
        {
            "symbol": "AAPL",
            "qty": "10",
            "avg_entry_price": "180.00",
            "current_price": "190.00",
            "unrealized_pl": "100.00",
        },
        {"symbol": "BAD", "qty": "x", "avg_entry_price": "y"},
    ]
    pf = portfolio_from(account, positions)
    assert pf["cash"] == 95000.5
    assert pf["equity"] == 100432.1
    assert pf["unrealized"] == 100.0
    aapl = next(p for p in pf["positions"] if p["symbol_key"] == "EQUITY:AAPL")
    assert aapl["qty"] == 10.0
    assert aapl["avg_cost"] == 180.0
    assert aapl["mark"] == 190.0
    assert aapl["unrealized_pct"] == pytest.approx(5.556, abs=0.01)
    assert all(p["symbol_key"] != "EQUITY:BAD" for p in pf["positions"])


def test_normalize_order_maps_status_and_fields():
    row = normalize_order({
        "id": "abc-123",
        "symbol": "AAPL",
        "side": "buy",
        "type": "limit",
        "qty": "5",
        "limit_price": "185.25",
        "stop_price": None,
        "time_in_force": "day",
        "status": "accepted",
        "filled_qty": "0",
        "filled_avg_price": None,
        "created_at": "2025-01-15T14:30:00Z",
        "leg": [],
    })
    assert row["id"] == "abc-123"
    assert row["symbol_key"] == "EQUITY:AAPL"
    assert row["status"] == "working"
    assert row["limit_price"] == 185.25
    assert row["created"] is not None


def test_normalize_order_filled():
    row = normalize_order({
        "id": "x",
        "symbol": "NVDA",
        "side": "sell",
        "type": "market",
        "qty": "3",
        "status": "filled",
        "filled_qty": "3",
        "filled_avg_price": "121.5",
        "created_at": "2025-01-15T14:30:00Z",
    })
    assert row["status"] == "filled"
    assert row["avg_fill"] == 121.5
    assert row["filled_qty"] == 3.0


# ---------------------------------------------------------------- routing


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


def test_orders_endpoint_venue_paper_default(client):
    _seed(client)
    r = client.post("/api/orders", json={
        "symbol_key": "CRYPTO:BTCUSDT", "side": "buy", "type": "market", "qty": 1,
    })
    assert r.status_code == 200
    assert r.json()["status"] == "filled"


def test_orders_endpoint_venue_alpaca_requires_keys(client):
    _seed(client)
    r = client.post("/api/orders", json={
        "symbol_key": "EQUITY:AAPL", "side": "buy", "type": "market", "qty": 1,
        "venue": "alpaca",
    })
    assert r.status_code == 400
    assert "Alpaca" in r.json()["detail"]


def test_alpaca_proxy_endpoints_require_keys(client):
    assert client.get("/api/alpaca/orders").status_code == 400
    assert client.get("/api/alpaca/portfolio").status_code == 400
    assert client.delete("/api/alpaca/orders/abc").status_code == 400


def test_settings_test_unknown_provider(client):
    r = client.post("/api/settings/test", json={"provider": "nope"})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def _seed(client, price=100.0):
    rt = client.app.state.runtime
    from datetime import datetime, timezone

    from openterm.core.events import Trade

    rt.handle(
        "tick:CRYPTO:BTCUSDT",
        Trade(symbol_key="CRYPTO:BTCUSDT", price=price, size=1.0,
              ts=datetime.now(timezone.utc)),
    )
