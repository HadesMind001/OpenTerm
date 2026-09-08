"""Security regressions around provider keys: leaks, echoes and origins.

Pinned behaviours (each maps to a real historical bug):
  * /settings/test used to answer with str(httpx.HTTPStatusError), which
    embeds the FULL request URL — for finnhub/FRED/Polygon the API key is a
    query parameter, so the error response handed the live key to whoever
    made the request. _safe_error() sanitizes; these assert the guarantee,
    not the wording.
  * GET /settings must only ever expose availability booleans.
  * LocalOriginGuard: a foreign Origin header is rejected blind-mutations
    (form POSTs, WS) from random websites; no/localhost origin still passes.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import openterm.api.routes as routes
from openterm.api.app import create_app
from openterm.api.app_guard import origin_allowed

CANARY = "CANARY-KEY-DO-NOT-LEAK"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OT_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


class _BoomClient:
    """Mimics the leak: httpx errors carry the full signed URL in str(exc)."""

    def __init__(self, *args, **kwargs):
        pass

    async def profile(self, symbol):
        request = httpx.Request(
            "GET", f"https://finnhub.io/api/v1/stock/profile2?symbol={symbol}&token={CANARY}"
        )
        raise httpx.HTTPStatusError(
            f"Client error '401 Unauthorized' for url '{request.url}'",
            request=request,
            response=httpx.Response(401, request=request),
        )


def test_keys_test_error_never_leaks_url_or_key(client, monkeypatch):
    monkeypatch.setattr(routes, "FinnhubClient", _BoomClient)
    r = client.post("/api/settings/test",
                    json={"provider": "finnhub", "key": CANARY})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    text = r.text
    assert CANARY not in text
    assert "finnhub.io" not in text
    assert "profile2" not in text
    # but the useful signal survives
    assert "401" in body["error"]


def test_settings_get_returns_availability_booleans_only(client):
    saved = client.post("/api/settings/keys", json={"finnhub_key": CANARY})
    assert saved.status_code == 200
    assert saved.json()["available"]["finnhub"] is True
    # the SAVE response must not echo the value either
    assert CANARY not in saved.text

    body = client.get("/api/settings")
    assert CANARY not in body.text
    assert isinstance(body.json()["available"], dict)
    assert body.json()["available"]["finnhub"] is True


def test_origin_guard_blocks_foreign_pages(client):
    evil = {"Origin": "https://evil.example"}
    assert client.get("/api/health", headers=evil).status_code == 403
    assert client.post("/api/watchlist", json={"query": "AAPL"},
                       headers=evil).status_code == 403
    ok = client.get("/api/health")  # no Origin at all (curl/native) passes
    assert ok.status_code == 200
    for good in ("http://localhost:5173", "http://127.0.0.1:8000"):
        assert client.get("/api/health",
                          headers={"Origin": good}).status_code == 200
    # `Origin: null` (sandboxed iframes, file://) is NOT local — reject.
    assert client.get("/api/health",
                      headers={"Origin": "null"}).status_code == 403


@pytest.mark.parametrize("origin,expected", [
    (None, True), ("", True),
    ("http://localhost:8000", True), ("http://[::1]:3000", True),
    ("null", False),
    ("https://evil.example", False), ("http://localhost.evil.example", False),
    ("not a url at all", False),
])
def test_origin_allowed_matrix(origin, expected):
    assert origin_allowed(origin) is expected
