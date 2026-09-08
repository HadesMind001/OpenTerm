from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from ..core.events import Bar, StatsSnapshot, Trade
from .base import Provider

log = logging.getLogger(__name__)

CHART = "https://query1.finance.yahoo.com/v8/finance/chart"

# (request-interval, range) per OUR interval. The entry that looks like a
# typo is the whole trick: Yahoo's v8 chart API does not offer a native 4h
# interval, so we ask for 1h and merge groups of four client-side (see
# backfill). 1d is NOT an option — a daily bar has no quartiles to cut. Two
# years of hourly is deep enough for any 4h chart we render and near the
# outer edge of what Yahoo serves hourly anyway.
_INTERVAL_MAP = {
    "1m": ("1m", "7d"),
    "5m": ("5m", "1mo"),
    "15m": ("15m", "2mo"),
    "1h": ("1h", "2y"),
    "4h": ("1h", "2y"),
    "1d": ("1d", "10y"),
    "1w": ("1wk", "10y"),
    "1M": ("1mo", "max"),
}


class YahooProvider(Provider):
    name = "yahoo"
    capabilities = frozenset({"bars", "snapshot"})
    poll_interval = 10.0

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._dead: set[str] = set()

    async def poll(self) -> None:
        equities = [
            i for i in self.watched.values()
            if i.yahoo and i.ticker not in self._dead
        ]
        if not equities:
            return
        results = await asyncio.gather(
            *(self._quote_one(i) for i in equities), return_exceptions=True
        )
        errors = [r for r in results if isinstance(r, Exception)]
        if len(errors) == len(equities):
            raise errors[0]
        self.set_status(True)

    async def _quote_one(self, inst) -> None:
        try:
            resp = await self.http.get(
                f"{CHART}/{inst.yahoo}",
                params={"interval": "1m", "range": "1d"},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # ONLY a real 404 marks the ticker dead for the process lifetime.
            # Yahoo answers rate-limiting with 422/429 shapes, and the old
            # (404, 422) tuple permanently blacklisted perfectly good tickers
            # the moment Yahoo got annoyed with us. Transient codes now raise
            # so poll() can back off and retry next round.
            if exc.response.status_code == 404:
                self._dead.add(inst.ticker)
                return
            raise
        result = (resp.json().get("chart") or {}).get("result") or []
        if not result:
            # 200-with-empty-result is Yahoo's "unknown ticker" answer.
            self._dead.add(inst.ticker)
            return
        meta: dict[str, Any] = result[0].get("meta") or {}
        last = meta.get("regularMarketPrice")
        if last is None:
            return
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        key = f"EQUITY:{inst.ticker}"
        change = None
        if prev:
            change = round((float(last) - float(prev)) / float(prev) * 100, 4)
        ts = datetime.now(timezone.utc)
        self.bus.publish(
            f"stats:{key}",
            StatsSnapshot(
                symbol_key=key,
                feed="YAHOO",
                ts=ts,
                last=float(last),
                prev_close=float(prev) if prev else None,
                day_high=meta.get("regularMarketDayHigh"),
                day_low=meta.get("regularMarketDayLow"),
                volume=meta.get("regularMarketVolume"),
                change_pct=change,
            ),
        )
        self.bus.publish(
            f"tick:{key}",
            Trade(symbol_key=key, feed="YAHOO", ts=ts,
                  price=float(last), size=0.0),
        )

    async def backfill(self, ticker: str, interval: str, limit: int) -> list[Bar]:
        if ticker in self._dead:
            return []
        yinterval, yrange = _INTERVAL_MAP.get(interval, ("1d", "2y"))
        try:
            resp = await self.http.get(
                f"{CHART}/{ticker}",
                params={"interval": yinterval, "range": yrange},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                self._dead.add(ticker)
            return []
        except Exception:
            # Network/parse trouble: return empty but keep the ticker alive —
            # a dead-symbol cache poisoned by an outage hides real symbols
            # until restart.
            log.debug("yahoo backfill failed for %s", ticker, exc_info=True)
            return []
        result = (resp.json().get("chart") or {}).get("result") or []
        if not result:
            return []
        node = result[0]
        stamps = node.get("timestamp") or []
        quote = ((node.get("indicators") or {}).get("quote") or [{}])[0]
        opens, highs, lows, closes, vols = (
            quote.get("open") or [],
            quote.get("high") or [],
            quote.get("low") or [],
            quote.get("close") or [],
            quote.get("volume") or [],
        )
        bars: list[Bar] = []
        # 4h ROLLUP: walk the 1h stamps in order, flush every FOUR rows into
        # one merged bar (open=first open, close=last close, extremes/sum
        # across the group). Counting, not bucketing: Yahoo's hourly stamps
        # are session-aligned (a US equity's first bar is 13:30 UTC), so a
        # count-of-four group can straddle epoch 4h boundaries. The stamp
        # below floors to the real boundary, which means a straddling group's
        # bar is a "4h" only in size, not in span — the known price of not
        # having a native 4h. (BarBuilder's LIVE 4h bars are true epoch
        # buckets; where the two compositions disagree, the store decides:
        # HistoryService refuses to touch a ts already present, while a live
        # closed upsert overwrites anything — so long-running sessions
        # eventually heal count-grouped history into real bucket bars.)
        step = 4 if interval == "4h" else 1
        bucket: list[tuple[int, float, float, float, float, float]] = []
        for i, t in enumerate(stamps):
            try:
                c = closes[i]
                if c is None:
                    continue
                o = opens[i] if i < len(opens) and opens[i] is not None else c
                h = highs[i] if i < len(highs) and highs[i] is not None else c
                l = lows[i] if i < len(lows) and lows[i] is not None else c
                v = vols[i] if i < len(vols) and vols[i] is not None else 0.0
            except IndexError:
                break
            bucket.append((int(t), float(o), float(h), float(l), float(c), float(v)))
            if interval == "4h" and len(bucket) == step:
                ts0, oo, hh, ll, cc, vv = _merge_bucket(bucket)
                bars.append(Bar(symbol_key=f"EQUITY:{ticker}", interval=interval,
                                ts=_floor4h(ts0), o=oo, h=hh, l=ll, c=cc, v=vv,
                                closed=True, feed="YAHOO"))
                bucket = []
        if interval == "4h" and bucket:
            # Leftover <4 rows (delisting, halt, the running bucket) still
            # ship with closed=True: backfill has no partial channel, and a
            # "final" short bar is better than silently dropping hours.
            ts0, oo, hh, ll, cc, vv = _merge_bucket(bucket)
            bars.append(Bar(symbol_key=f"EQUITY:{ticker}", interval=interval,
                            ts=_floor4h(ts0), o=oo, h=hh, l=ll, c=cc, v=vv,
                            closed=True, feed="YAHOO"))
        elif interval != "4h":
            for t, o, h, l, c, v in bucket:
                bars.append(Bar(symbol_key=f"EQUITY:{ticker}", interval=interval,
                                ts=t, o=o, h=h, l=l, c=c, v=v,
                                closed=True, feed="YAHOO"))
        return bars[-limit:] if limit else bars


def _merge_bucket(rows):
    _, o = rows[0][0], rows[0][1]
    h = max(r[2] for r in rows)
    l = min(r[3] for r in rows)
    c = rows[-1][4]
    v = sum(r[5] for r in rows)
    return rows[0][0], o, h, l, c, v


def _floor4h(ts: int) -> int:
    # MUST stay identical to BarBuilder's `ts // INTERVALS["4h"] * ...` with
    # 4h = 14400s (services/bars.py). The bars table is keyed on
    # (symbol, interval, ts): if this stamp and the live bucket math ever
    # disagree on where a bucket starts, backfilled and live-built 4h bars
    # occupy DIFFERENT keys for the same window and the series forks in the
    # DB — no error, just double bars forever. If you edit one, edit both
    # and re-ingest.
    return int(ts) // 14400 * 14400
