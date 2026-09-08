from __future__ import annotations

import asyncio

import pytest

from openterm.services.universe import UniverseMeta


class FakeFinnhub:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def profile(self, ticker: str) -> dict:
        self.calls.append(("profile", ticker))
        return {
            "name": ticker,
            "finnhubIndustry": "Technology Hardware",
            "logo": "https://example.com/logo.png",
        }

    async def metrics(self, ticker: str) -> dict:
        return {"market_cap_m": 123456.7}


async def test_refresh_populates_and_serves_cache():
    meta = UniverseMeta(FakeFinnhub(), http=None)
    n = await meta.refresh(["EQUITY:AAPL", "EQUITY:MSFT"])
    assert n == 2

    row = meta.get("EQUITY:AAPL")
    assert row is not None
    assert row["sector"] == "Technology Hardware"
    assert row["industry"] == "Technology Hardware"
    assert row["market_cap_m"] == 123456.7


async def test_disabled_without_finnhub():
    meta = UniverseMeta(None, http=None)
    assert await meta.refresh(["EQUITY:AAPL"]) == 0


async def test_unknown_keys_are_skipped():
    meta = UniverseMeta(FakeFinnhub(), http=None)
    # non-equity / unresolvable keys are filtered out
    n = await meta.refresh(["EQUITY:NOTAREALSYMBOL", "CRYPTO:BTC"])
    assert n == 0


def test_get_without_fetch_returns_none():
    meta = UniverseMeta(FakeFinnhub(), http=None)
    assert meta.get("EQUITY:AAPL") is None
