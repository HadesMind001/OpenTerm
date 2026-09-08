"""Options chain provider (Finnhub) + Black-Scholes greeks.

Finnhub's option-chain endpoint is plan-gated and its payload shape has
changed more than once; every parser here is defensive and returns None on
surprise, which surfaces as an honest HTTP 404 "not available". There is NO
"Yahoo options fallback" — the previous one fetched a price chart and returned
`{"calls": [], "puts": []}`, which the route then served as a successful empty
chain (a truthy dict!), i.e. the UI showed "this stock has no options" for
every single symbol whenever Finnhub hiccuped.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from pydantic import BaseModel
from scipy.stats import norm as scipy_norm

log = logging.getLogger(__name__)

BASE = "https://finnhub.io/api/v1"
OPTION_CHAIN_PATH = "/stock/option-chain"  # the old URL contained LITERAL SPACES


class OptionChainRow(BaseModel):
    strike: float
    right: str  # "call" or "put"
    bid: float
    ask: float
    last: float | None
    volume: int
    open_interest: int
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    rho: float | None = None
    implied_vol: float | None = None
    timestamp: float


class OptionsService:
    """Options chain provider backed by Finnhub (key required)."""

    def __init__(self, http: httpx.AsyncClient, finnhub_key: str | None = None) -> None:
        self.http = http
        self.finnhub_key = finnhub_key
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_ttl: dict[str, float] = {}
        self._cache_ttl_seconds = 300  # 5 minutes; chains are slow-moving

    async def get_chain(self, symbol: str) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc).timestamp()
        hit = self._cache.get(symbol)
        if hit and now - self._cache_ttl.get(symbol, 0) < self._cache_ttl_seconds:
            return hit

        if not self.finnhub_key:
            return None
        chain = await self._fetch_finnhub_chain(symbol)
        if chain is None:
            return None
        self._cache[symbol] = chain
        self._cache_ttl[symbol] = now
        return chain

    async def _fetch_finnhub_chain(self, symbol: str) -> dict[str, Any] | None:
        try:
            r = await self.http.get(
                f"{BASE}{OPTION_CHAIN_PATH}",
                params={"symbol": symbol, "token": self.finnhub_key},
            )
            if r.status_code != 200:
                # 401/403 = plan doesn't include it; 422 = unknown symbol.
                # Either way: honest None, no silent swallow.
                log.debug("finnhub option chain %s -> HTTP %d", symbol, r.status_code)
                return None
            data = r.json() or {}
        except (httpx.HTTPError, ValueError):
            log.debug("finnhub option chain fetch failed", exc_info=True)
            return None

        ts = time.time()
        result: dict[str, Any] = {"calls": [], "puts": [], "symbol": symbol}
        # Real-world key names are camelCase ("callExpire"); the old parser
        # looked for snake_case that Finnhub has never returned — combined with
        # the missing `time` import (NameError swallowed to None), the whole
        # feature has therefore NEVER worked. Parse both spellings defensively.
        for side, keys in (("calls", ("callExpire", "call_expire")),
                           ("puts", ("putExpire", "put_expire"))):
            groups: list = []
            for k in keys:
                groups = data.get(k) or []
                if groups:
                    break
            for grp in groups:
                for chain in grp.get("optionChain") or []:
                    strike = chain.get("strike") or 0
                    for c in chain.get("contracts") or []:
                        result[side].append({
                            "strike": strike,
                            "right": "call" if side == "calls" else "put",
                            "bid": c.get("bid", 0.0),
                            "ask": c.get("ask", 0.0),
                            "last": c.get("close") if c.get("close") is not None else c.get("last"),
                            "volume": int(c.get("volume") or 0),
                            "open_interest": int(c.get("open_interest") or 0),
                            "implied_vol": c.get("iv"),
                            "timestamp": ts,
                        })
        if not result["calls"] and not result["puts"]:
            return None  # shaped differently than expected or plan-gated
        return result


def _black_scholes_greeks(
    S: float, K: float, T_years: float, r: float, sigma: float, option_type: str = "call"
) -> dict[str, float | None]:
    """Black-Scholes greeks for a European option.

    UNITS (this function used to receive `T` in DAYS while every formula here
    assumes YEARS — delta came out ~1.0 for a 30-day option, which is how you
    can tell nobody ever sanity-checked the numbers):
      T_years : time to expiry in years
      theta   : per calendar day   (annual /365)
      vega    : per 1 vol point    (/100)
      rho     : per 1% rate move   (/100)
    """
    if T_years <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return {"delta": None, "gamma": None, "theta": None, "vega": None, "rho": None}

    sqrt_t = math.sqrt(T_years)
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T_years) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t

    if option_type == "call":
        delta = scipy_norm.cdf(d1)
        rho = K * T_years * scipy_norm.cdf(d2) / 100.0
        theta = (
            -S * scipy_norm.pdf(d1) * sigma / (2 * sqrt_t)
            - r * K * scipy_norm.cdf(d2)
        ) / 365.0
    else:
        delta = scipy_norm.cdf(d1) - 1.0
        rho = -K * T_years * scipy_norm.cdf(-d2) / 100.0
        theta = (
            -S * scipy_norm.pdf(d1) * sigma / (2 * sqrt_t)
            + r * K * scipy_norm.cdf(-d2)
        ) / 365.0

    gamma = scipy_norm.pdf(d1) / (S * sigma * sqrt_t)
    vega = S * scipy_norm.pdf(d1) * sqrt_t / 100.0

    return {
        "delta": round(float(delta), 4),
        "gamma": round(float(gamma), 6),
        "theta": round(float(theta), 4),
        "vega": round(float(vega), 4),
        "rho": round(float(rho), 4),
    }


def compute_greeks(
    spot: float, strike: float, expiry_days: float, rate: float = 0.05,
    iv: float | None = None, option_type: str = "call",
) -> dict[str, float | None]:
    """Days in, greeks out. The /365 conversion lives HERE — the one place
    that speaks both 'humans think in days' and 'Black-Scholes thinks in
    years'. Do not move the conversion into the caller; that is how the old
    bug (raw days fed as years) was born."""
    return _black_scholes_greeks(
        spot, strike, expiry_days / 365.0, rate, iv or 0.3, option_type
    )


__all__ = ["OptionsService", "OptionChainRow", "compute_greeks"]
