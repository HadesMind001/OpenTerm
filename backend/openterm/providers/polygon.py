from __future__ import annotations

import time
import httpx

from ..core.events import Bar
from .base import check_status

BASE = "https://api.polygon.io"

_INTERVAL_MAP = {
    "1m": (1, "minute"),
    "5m": (5, "minute"),
    "15m": (15, "minute"),
    "1h": (1, "hour"),
    "4h": (4, "hour"),
    "1d": (1, "day"),
}

_SPAN_MS = {"minute": 60_000, "hour": 3_600_000, "day": 86_400_000}


def parse_aggs(data: dict, ticker: str, interval: str) -> list[Bar]:
    results = data.get("results") or []
    out: list[Bar] = []
    for row in results:
        try:
            out.append(
                Bar(
                    symbol_key=f"EQUITY:{ticker}",
                    feed="POLYGON",
                    interval=interval,
                    ts=int(row["t"] // 1000),
                    o=float(row["o"]),
                    h=float(row["h"]),
                    l=float(row["l"]),
                    c=float(row["c"]),
                    v=float(row.get("v", 0)),
                    closed=True,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


class PolygonClient:
    """Key-gated equity/crypto aggregates backfill."""

    def __init__(self, key: str, http: httpx.AsyncClient | None = None) -> None:
        self.key = key
        # See FinnhubClient._owns_http note — same dangling-client trap.
        self._owns_http = http is None
        self.http = http or httpx.AsyncClient(timeout=15.0)

    async def aclose(self) -> None:
        if self._owns_http:
            await self.http.aclose()

    async def backfill(self, ticker: str, interval: str, limit: int) -> list[Bar]:
        mult, timespan = _INTERVAL_MAP.get(interval, (1, "day"))
        to_ms = int(time.time() * 1000)
        span = _SPAN_MS[timespan] * mult
        from_ms = to_ms - span * max(limit + 5, 30)
        r = await self.http.get(
            f"{BASE}/v2/aggs/ticker/{ticker}/range/{mult}/{timespan}/{from_ms}/{to_ms}",
            params={"apiKey": self.key, "limit": min(limit, 1000), "sort": "asc"},
        )
        check_status(r, "polygon")
        return parse_aggs(r.json(), ticker, interval)[-limit:]
