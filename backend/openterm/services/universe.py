"""Cached Finnhub market metadata (sector, market cap) per equity.

The heatmap sizes tiles by market capitalisation and groups them by sector.
This service fetches those fields from Finnhub on a per-symbol basis, caches
the results on the runtime with a TTL, and exposes a throttled background
refresh for the currently-watched equity universe.

Finnhub's free `profile2` only provides `finnhubIndustry`, so that field is
used as the grouping "sector".  No Finnhub key means no metadata: callers
fall back to volume-sizing and asset-class grouping (see HeatmapPage).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from ..core.symbols import ASSET_EQUITY, from_key

log = logging.getLogger(__name__)

# Finnhub free-tier is roughly 30 requests/min.  Fetching profile2 + metrics is
# 2 calls/symbol, so keep a conservative pacing and TTLs that avoid re-pull.
_MIN_INTERVAL_S = 3.0  # min seconds between symbols
_CAP_TTL_S = 24 * 3600  # market cap changes intraday → refresh daily
_SECTOR_TTL_S = 7 * 24 * 3600  # sector/industry are stable

_MARKET_CAP_KEY = "market_cap_m"
_SECTOR_KEY = "sector"
_INDUSTRY_KEY = "industry"


class UniverseMeta:
    """Per-symbol Finnhub market metadata cache + throttled refresher."""

    def __init__(self, finnhub: Any, http: Any) -> None:
        self.finnhub = finnhub
        self.http = http
        self._cache: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._last_fetch = 0.0
        self._task: asyncio.Task | None = None

    # -- cache reads ------------------------------------------------------

    def get(self, symbol_key: str) -> dict[str, Any] | None:
        row = self._cache.get(symbol_key)
        if not row:
            return None
        now = time.time()
        cap = row.get("market_cap_m")
        sector = row.get("sector")
        cur = {}
        if cap is not None and now - row.get("cap_ts", 0) < _CAP_TTL_S:
            cur[_MARKET_CAP_KEY] = cap
        if sector and now - row.get("sector_ts", 0) < _SECTOR_TTL_S:
            cur[_SECTOR_KEY] = sector
            if row.get("industry"):
                cur[_INDUSTRY_KEY] = row["industry"]
        return cur or None

    def _note_fetch(self, symbol_key: str, data: dict[str, Any]) -> None:
        now = time.time()
        prev = self._cache.get(symbol_key, {})
        merged = {**prev, "fetched_at": now}
        sector = data.get("finnhubIndustry")
        if sector:
            merged[_SECTOR_KEY] = sector
            merged[_INDUSTRY_KEY] = sector
            merged["sector_ts"] = now
        if data.get("market_cap_m") is not None:
            merged[_MARKET_CAP_KEY] = data["market_cap_m"]
            merged["cap_ts"] = now
        self._cache[symbol_key] = merged

    # -- fetching ---------------------------------------------------------

    async def refresh(self, keys: list[str]) -> int:
        """Fetch fundamentals for equity keys, respecting rate limits.

        Returns the number of symbols successfully enriched.

        PACING RATIONALE — the whole point of this function's shape: free-tier
        upstreams publish soft limits and hard grudges. The contract is
        asymmetric on purpose: we pay in time, they spare us the 429 (and the
        silent ban that follows a repeated one — a throttled 429 is loud and
        fixable; a quietly dropped key is a week of debugging). So the loop
        sleeps _MIN_INTERVAL_S between symbols and treats every deadline as
        skippable.
        """
        if self.finnhub is None:
            return 0
        done = 0  # symbols successfully enriched
        # The lock spans the ENTIRE batch, sleeps included. Without it two
        # overlapping refresh() calls (startup + the 600s loop + a settings
        # hot-swap all call this) would each pass the wait-check on the same
        # stale _last_fetch and fire paired bursts straight at the rate limit
        # — the one thing _MIN_INTERVAL_S exists to prevent.
        async with self._lock:
            for key in keys:
                inst = from_key(key)
                if inst is None or inst.asset_class != ASSET_EQUITY or not inst.yahoo:
                    continue
                row = self._cache.get(key)
                now = time.time()
                # Freshness must hold for BOTH fields, not either: with an
                # `or` here, a row whose market cap expired but whose sector
                # is inside the week TTL would be skipped forever — sector
                # freshness would mask a year-old cap. The price of correctness
                # is re-hammering the stable field: two calls per symbol is
                # the fetch granularity, so any expiry refreshes both.
                if row and (
                    (row.get("cap_ts", 0) + _CAP_TTL_S > now)
                    and (row.get("sector_ts", 0) + _SECTOR_TTL_S > now)
                ):
                    continue
                # Re-read the clock: `now` above was taken before the TTL
                # check, and the PREVIOUS iteration's fetches may have burned
                # seconds — wait must be measured against this instant or the
                # pacing floor erodes batch by batch.
                now_second = time.time()
                wait = self._last_fetch + _MIN_INTERVAL_S - now_second
                if wait > 0:
                    await asyncio.sleep(wait)
                # Stamp BEFORE the fetch, not after: if Finnhub is slow and a
                # request pair burns 4s, the next symbol sees wait<=0 and goes
                # immediately — correct, because the limit counts requests per
                # minute and a slow upstream is already self-throttling.
                self._last_fetch = time.time()
                try:
                    data = await self.finnhub.profile(inst.ticker)
                    metrics = await self.finnhub.metrics(inst.ticker)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    # One symbol's failure must not abort the batch: skip it,
                    # leave its cached values (and their old timestamps)
                    # untouched, and let the next pass retry naturally — the
                    # freshness check at the top of the loop only skips rows
                    # that are genuinely fresh.
                    log.warning("universe meta failed for %s: %s", key, exc)
                    continue
                self._note_fetch(
                    key,
                    {
                        "finnhubIndustry": data.get("finnhubIndustry"),
                        "market_cap_m": metrics.get("market_cap_m"),
                    },
                )
                done += 1
        return done

    async def start(self, get_keys) -> None:
        """Begin periodic background refresh of the given universe of keys."""

        async def loop() -> None:
            while True:
                try:
                    await self.refresh(get_keys())
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    log.exception("universe refresh loop error")
                await asyncio.sleep(600)
                # 10 minutes despite daily/weekly TTLs: the loop exists to
                # catch *watchlist membership* changes (new equity added =
                # fetched within one pass), not to re-pull data. TTL hits make
                # an unchanged steady state cost ~zero requests per pass.

        if self._task is None:
            self._task = asyncio.create_task(loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
