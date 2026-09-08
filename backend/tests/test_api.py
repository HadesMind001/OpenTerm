from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True


def test_resolve_endpoint(client):
    ok = client.get("/api/symbols/resolve", params={"q": "btc"})
    assert ok.status_code == 200
    assert ok.json()["symbol_key"] == "CRYPTO:BTCUSDT"
    bad = client.get("/api/symbols/resolve", params={"q": "!!!"})
    assert bad.status_code == 404


def test_watchlist_crud(client):
    added = client.post("/api/watchlist", json={"query": "AAPL US"})
    assert added.status_code == 200
    assert added.json()["symbol_key"] == "EQUITY:AAPL"
    items = client.get("/api/watchlist").json()
    assert [i["symbol_key"] for i in items] == ["EQUITY:AAPL"]
    dup = client.post("/api/watchlist", json={"query": "AAPL"})
    assert dup.status_code == 200
    items = client.get("/api/watchlist").json()
    assert len(items) == 1
    removed = client.delete("/api/watchlist/EQUITY:AAPL")
    assert removed.json()["removed"] is True
    assert client.get("/api/watchlist").json() == []


def test_bars_bad_key_rejected(client):
    r = client.get("/api/bars/garbage", params={"interval": "1m"})
    assert r.status_code == 404


def test_snapshot_empty_ok(client):
    r = client.get("/api/snapshot")
    assert r.status_code == 200
    assert r.json()["market"] == {}


def test_ws_hello_frame(client):
    with client.websocket_connect("/ws") as ws:
        frame = ws.receive_json()
        assert frame["t"] == "hello"
        assert isinstance(frame["statuses"], dict)
