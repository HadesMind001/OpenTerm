from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


def _seed_market(client, price=100.0):
    rt = client.app.state.runtime
    from datetime import datetime, timezone

    from openterm.core.events import Trade

    rt.handle(
        "tick:CRYPTO:BTCUSDT",
        Trade(symbol_key="CRYPTO:BTCUSDT", price=price, size=1.0,
              ts=datetime.now(timezone.utc)),
    )


def test_order_lifecycle_rest(client):
    _seed_market(client)
    r = client.post("/api/orders", json={
        "symbol_key": "CRYPTO:BTCUSDT", "side": "buy", "type": "market", "qty": 1,
    })
    assert r.status_code == 200
    assert r.json()["status"] == "filled"

    pf = client.get("/api/portfolio").json()
    assert pf["equity"] < 100000 or pf["positions"]
    assert any(p["symbol_key"] == "CRYPTO:BTCUSDT" for p in pf["positions"])

    fills = client.get("/api/fills").json()
    assert len(fills) == 1


def test_limit_order_working_and_cancel(client):
    _seed_market(client)
    r = client.post("/api/orders", json={
        "symbol_key": "CRYPTO:BTCUSDT", "side": "buy", "type": "limit",
        "qty": 2, "limit_price": 10.0,
    })
    oid = r.json()["id"]
    working = client.get("/api/orders", params={"status": "working"}).json()
    assert any(o["id"] == oid for o in working)
    assert client.delete(f"/api/orders/{oid}").json()["canceled"] is True
    assert client.delete(f"/api/orders/{oid}").status_code == 400


def test_reject_bad_order(client):
    _seed_market(client)
    r = client.post("/api/orders", json={
        "symbol_key": "CRYPTO:BTCUSDT", "side": "sell", "type": "market", "qty": 99,
    })
    assert r.status_code == 400
    assert "insufficient" in r.json()["detail"]


def test_cash_and_journal(client):
    r = client.post("/api/cash", json={"amount": 5000})
    assert r.status_code == 200
    j = client.post("/api/journal", json={
        "symbol_key": "CRYPTO:BTCUSDT", "text": "broke resistance", "tags": "breakout",
    }).json()
    entries = client.get("/api/journal").json()
    assert len(entries) == 1 and entries[0]["text"] == "broke resistance"
    assert client.delete(f"/api/journal/{j['id']}").json()["removed"] is True


def test_analytics_endpoint(client):
    _seed_market(client)
    a = client.get("/api/analytics").json()
    assert "points" in a and "trades" in a
