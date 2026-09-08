from __future__ import annotations

import time
from typing import Any

from ..core.bus import EventBus
from ..core.events import Bar, Trade

INTERVALS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
    "1M": 2592000,
}

_BASE = "1m"
_ROLLUPS = ["5m", "15m", "1h", "4h", "1d"]


class BarBuilder:
    """Aggregates ticks into 1m bars and every rollup interval alongside them.

    (First line reworded once the rollup-from-1m path died: the ladder is
    now fed by trades for all intervals, see seed().)

    Publishes partial bars on every tick and closed=True bars at bucket
    boundaries.

    The publishing contract, precisely — downstream code relies on every word:
    - PARTIAL: republished in full on EVERY tick, so a WS client can render
      the live candle without ever asking for it. Never persisted; treat
      closed=False as display-only.
    - CLOSED: published exactly once per bucket, and only LATE — a bucket
      closes when the first tick of the NEXT bucket arrives, not when wall
      time crosses the boundary. A dead symbol's last bar of the day stays
      "open" forever and is never written to the DB; on restart seed()
      resurrects only buckets the wall clock still considers current. If you
      need timer-driven closes for low-traffic symbols, add them HERE; do
      not let consumers guess from partial age.
    - Every rollup interval is fed from raw trades, not from 1m bars — so
      volume/OHLC per interval are exact w.r.t. the tick stream and one
      another (see seed()'s note about the abandoned rollup-from-1m path).
    """

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self.current: dict[tuple[str, str], dict[str, Any]] = {}

    def update(self, trade: Trade) -> None:
        ts = int(trade.ts.timestamp())
        closed = self._advance(trade.symbol_key, _BASE, ts, trade.price, trade.size)
        if closed:
            self.publish(closed)
        else:
            partial = self._partial(trade.symbol_key, _BASE)
            if partial:
                self.publish(partial)
        for iv in _ROLLUPS:
            iv_closed = self._advance(trade.symbol_key, iv, ts,
                                      trade.price, trade.size)
            if iv_closed:
                self.publish(iv_closed)
            else:
                partial = self._partial(trade.symbol_key, iv)
                if partial:
                    self.publish(partial)

    def publish(self, bar: Bar) -> None:
        self.bus.publish(f"bar:{bar.symbol_key}:{bar.interval}", bar)

    def _advance(
        self, key: str, interval: str, ts: int, price: float, size: float
    ) -> Bar | None:
        # BUCKET MATH — the load-bearing line of the whole file:
        # `ts // secs * secs` floors to epoch, so bucket boundaries are fixed
        # wall-clock instants (for 4h: 00/04/08/12/16/20 UTC), identical in
        # every process, every restart, and — MUST stay identical — with the
        # providers' own stamps (yahoo._floor4h is the same expression with
        # the same 14400). bars' PRIMARY KEY is (symbol, interval, ts): if
        # live-built and backfilled bars ever disagree on where a 4h bucket
        # starts, the same window lands on two different ts values and the
        # persisted series forks with overlapping bars that neither upsert
        # nor the frontend can reconcile. Changing the floor here means
        # changing it everywhere and re-ingesting history.
        #
        # Two honest caveats baked into this choice:
        # - epoch anchoring ignores exchange sessions: an equity "4h" bar
        #   straddles the 13:30 UTC open (12:00 bucket = half pre-market),
        #   "1w" buckets start on Thursdays (epoch day 0 was one), and "1M"
        #   is a 30-day month because months aren't a fixed second count.
        #   For 24/7 crypto none of this matters; for equities it's a
        #   knowingly-approximate calendar we share with the backfill path.
        # - no out-of-order handling: a late trade with ts in the previous
        #   bucket will "close" the live one early (persisting a partial bar
        #   as final) and reopen a dead bucket. Feeds we consume are
        #   effectively arrival-ordered, so this is a tolerated bug — until a
        #   multi-venue merge makes lateness routine. Fix it in this method.
        secs = INTERVALS[interval]
        bucket = ts // secs * secs
        cur = self.current.get((key, interval))
        closed = None
        if cur and cur["ts"] != bucket:
            closed = self._emit(key, interval, cur, True)
            cur = None
        if cur is None:
            cur = {"ts": bucket, "o": price, "h": price, "l": price,
                   "c": price, "v": size}
            self.current[(key, interval)] = cur
        else:
            cur["h"] = max(cur["h"], price)
            cur["l"] = min(cur["l"], price)
            cur["c"] = price
            cur["v"] += size
        return closed

    def seed(self, key: str, interval: str, row: dict) -> None:
        """Seed the in-progress bucket for `interval` from persisted history.

        Why this exists: bucket state is in-memory only, so a restart in the
        middle of a 5m candle loses its first minutes and the eventual "5m"
        bar would quietly under-report volume. update() rolls every interval
        directly off the trade stream (this replaced the old half-wired
        rollup-from-1m path, which had zero callers — two designs in one file,
        neither complete), so seeding needs only the LAST persisted row per
        (symbol, interval) IF its bucket is still the current wall-clock one.
        """
        secs = INTERVALS.get(interval)
        if not secs:
            return
        now_bucket = int(time.time()) // secs * secs
        # The staleness gate matters: current[] holding an ALREADY-CLOSED
        # bucket makes the next tick re-emit it as a fresh close. The upsert
        # is idempotent, so the DB survives — but runtime.handle() feeds
        # every closed 1m bar to alerts.on_bar(), so a restart at midnight
        # would double-fire yesterday's bar alerts. Same-floor math keeps
        # current-bucket rows safe to adopt: their ts is the bucket the next
        # trade lands in.
        if int(row["ts"]) == now_bucket:
            self.current[(key, interval)] = {
                "ts": int(row["ts"]), "o": float(row["o"]), "h": float(row["h"]),
                "l": float(row["l"]), "c": float(row["c"]), "v": float(row["v"]),
            }

    def _partial(self, key: str, interval: str) -> Bar | None:
        cur = self.current.get((key, interval))
        return self._emit(key, interval, cur, False) if cur else None

    def _emit(self, key: str, interval: str, cur: dict, closed: bool) -> Bar:
        return Bar(symbol_key=key, interval=interval, feed="AGG", ts=cur["ts"],
                   o=cur["o"], h=cur["h"], l=cur["l"], c=cur["c"], v=cur["v"],
                   closed=closed)

    def seed_from_bars(self, bars: list[Bar]) -> None:
        """Initialize state from history so partial bars continue seamlessly.

        WARNING: unlike seed(), this does NOT check that the last row's
        bucket is still current — feeding it finished history plants a dead
        bucket that the next trade re-publishes as a duplicate close (see
        seed()'s staleness note for what that does to bar alerts). It has no
        production callers; runtime seeds per (symbol, interval) through
        seed(). It survives for tests and will get deleted the day someone
        finally audits it.
        """
        by_interval: dict[str, list[Bar]] = {}
        for b in bars:
            by_interval.setdefault(b.interval, []).append(b)
        for iv, rows in by_interval.items():
            rows.sort(key=lambda b: b.ts)
            if rows:
                last = rows[-1]
                self.current[(last.symbol_key, iv)] = {
                    "ts": last.ts, "o": last.o, "h": last.h, "l": last.l,
                    "c": last.c, "v": last.v,
                }
