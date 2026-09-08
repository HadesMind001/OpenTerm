from __future__ import annotations

from datetime import timedelta, datetime, timezone
from typing import Any

import httpx

from .base import check_status

BASE = "https://finnhub.io/api/v1"


class FinnhubClient:
    """Key-gated REST client: profiles, basic financials, earnings calendar."""

    def __init__(self, key: str, http: httpx.AsyncClient | None = None) -> None:
        self.key = key
        # Fallback client only exists for tests; the app always injects the
        # shared client. If you construct one ad hoc, aclose() it — it used to
        # be created silently and left dangling (socket warnings at GC time).
        self._owns_http = http is None
        self.http = http or httpx.AsyncClient(timeout=10.0)

    async def aclose(self) -> None:
        if self._owns_http:
            await self.http.aclose()

    async def profile(self, ticker: str) -> dict[str, Any]:
        r = await self.http.get(
            f"{BASE}/stock/profile2",
            params={"symbol": ticker, "token": self.key},
        )
        check_status(r, "finnhub")
        return r.json() or {}

    async def metrics(self, ticker: str) -> dict[str, Any]:
        r = await self.http.get(
            f"{BASE}/stock/metric",
            params={"symbol": ticker, "metric": "all", "token": self.key},
        )
        check_status(r, "finnhub")
        data = r.json() or {}
        metric = data.get("metric") or {}
        picks = {
            "pe": metric.get("peBasicExclExtraTTM"),
            "eps_ttm": metric.get("epsExcludingExtraItemsTTM")
            or metric.get("epsInclExtraItemsTTM"),
            "beta": metric.get("beta"),
            "week52_high": metric.get("52WeekHigh"),
            "week52_low": metric.get("52WeekLow"),
            "div_yield": metric.get("dividendYieldIndicatedAnnual"),
            "market_cap_m": metric.get("marketCapitalization"),
            "rsi_1m": metric.get("rsi1M"),
            "target_avg": metric.get("targetMeanPrice"),
            "recommendation": metric.get("recommendationMean"),
        }
        return {k: v for k, v in picks.items() if v is not None}

    async def earnings(self, days: int = 14) -> list[dict[str, Any]]:
        # UTC, not date.today(): the app is UTC everywhere and Finnhub
        # calendars are US-dated; a host on UTC+11 at 13:00 local would ask
        # for a window starting "tomorrow" and silently miss the day's
        # earnings. 15-line bug, one line of tz.
        today = datetime.now(timezone.utc).date()
        r = await self.http.get(
            f"{BASE}/calendar/earnings",
            params={
                "from": today.isoformat(),
                "to": (today + timedelta(days=days)).isoformat(),
                "token": self.key,
            },
        )
        check_status(r, "finnhub")
        return r.json().get("earningsCalendar") or []
