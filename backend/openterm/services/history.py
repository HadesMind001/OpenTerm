from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

from ..core.events import Bar
from ..core.store import Store
from ..core.symbols import from_key
from ..providers.binance_ws import BinanceProvider
from ..providers.polygon import PolygonClient
from ..providers.yahoo import YahooProvider


class HistoryService:
    """Chart seeding: store first, then provider REST backfill, merged."""

    def __init__(
        self,
        store: Store,
        binance: BinanceProvider,
        yahoo: YahooProvider,
        polygon: PolygonClient | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.store = store
        self.binance = binance
        self.yahoo = yahoo
        self.polygon = polygon
        # Shared pooled client. The old code spun a fresh httpx.AsyncClient
        # per klines request — TLS handshake per chart drag, and the
        # connection pool bought nothing. Falls back to binance's client so
        # existing call sites (tests) keep working.
        self.http = http or binance.http

    async def bars(self, symbol_key: str, interval: str, limit: int = 400) -> list[dict]:
        rows = self.store.get_bars(symbol_key, interval, limit=limit)
        if len(rows) >= limit:
            return rows
        fetched = await self._backfill(symbol_key, interval, limit)
        if not fetched:
            return rows
        seen = {r["ts"] for r in rows}
        new_rows = [
            {
                "ts": b.ts,
                "o": b.o,
                "h": b.h,
                "l": b.l,
                "c": b.c,
                "v": b.v,
            }
            for b in fetched
            if b.ts not in seen
        ]
        if new_rows:
            self.store.upsert_bars(
                (symbol_key, interval, r["ts"], r["o"], r["h"], r["l"], r["c"], r["v"])
                for r in new_rows
            )
            rows = sorted(rows + new_rows, key=lambda r: r["ts"])[-limit:]
        return rows

    async def _backfill(self, symbol_key: str, interval: str, limit: int) -> list[Bar]:
        inst = from_key(symbol_key)
        if inst is None:
            return []
        try:
            if inst.asset_class == "CRYPTO" and inst.binance:
                return await self._binance_klines(inst.ticker, interval, limit)
            if inst.asset_class == "EQUITY" and inst.yahoo:
                if self.polygon is not None:
                    try:
                        return await self.polygon.backfill(
                            inst.ticker, interval, limit
                        )
                    except Exception:
                        # Polygon hiccup is survivable (Yahoo is next) but must
                        # not be invisible: "why are my charts 1m?" investigations
                        # end here.
                        log.debug("polygon backfill failed for %s", inst.ticker,
                                  exc_info=True)
                return await self.yahoo.backfill(inst.ticker, interval, limit)
        except Exception:
            log.debug("history backfill failed for %s %s", symbol_key, interval,
                      exc_info=True)
            return []
        return []

    async def _binance_klines(self, pair: str, interval: str, limit: int) -> list[Bar]:
        url = "https://api.binance.com/api/v3/klines"
        params = {"symbol": pair, "interval": interval, "limit": max(1, min(int(limit), 1000))}
        resp = await self.http.get(url, params=params)
        resp.raise_for_status()
        key = f"CRYPTO:{pair}"
        out = [
            Bar(
                symbol_key=key,
                feed="BINANCE",
                interval=interval,
                ts=int(row[0] // 1000),
                o=float(row[1]),
                h=float(row[2]),
                l=float(row[3]),
                c=float(row[4]),
                v=float(row[5]),
                closed=True,
            )
            for row in resp.json()
        ]
        return out[-limit:]
