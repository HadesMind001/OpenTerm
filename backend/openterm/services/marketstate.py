from __future__ import annotations

from typing import Any

from ..core.events import Depth, Quote, StatsSnapshot, Trade


class MarketState:
    """Latest trade/quote/stats per symbol; answers "what is X doing right now"."""

    # INVARIANTS (read before adding a writer):
    # - The ONLY writers are MarketState.update_* calls, and their only caller
    #   is Runtime.handle() — i.e. the 16 dispatch tasks. All handlers are
    #   synchronous, and async readers (routes, ws gateway) are `async def`
    #   running on the same event-loop thread, so single-threaded asyncio IS
    #   the lock: no await can interleave inside an update. Add an `await` or
    #   a threadpool reader and this dict is racing.
    # - Per field, last writer wins on wall-clock arrival order, NOT event ts:
    #   `updated` records the event's own timestamp, so an out-of-order quote
    #   can set bid/ask "from the past" while `updated` moves backwards.
    #   Nothing reconciles it; consumers live with it.
    # - change_pct is DERIVED, not stored-truth: whenever both last and
    #   prev_close are known, _recompute overwrites whatever change_pct a
    #   StatsSnapshot brought in (providers compute it against their own
    #   session rules; we standardize on (last-prev_close)/prev_close).
    # - "Day stats" are only as good as the feed: Binance's ticker/24hr is a
    #   ROLLING 24h window (no roll-over at any midnight), Yahoo's is the
    #   regular session. Mixed feeds mean day_high may not be comparable
    #   across feeds; the latest snapshot for a symbol simply wins per field.
    # - Nones are ignored on stats updates: a partial snapshot (Yahoo often
    #   omits day_high pre-open) must never erase a field another feed
    #   already filled.
    # - Trade vs quote precedence: `last` comes ONLY from trades (and stats),
    #   never from bid/ask mid. A wide/broken book cannot fake a price move.

    def __init__(self) -> None:
        self._state: dict[str, dict[str, Any]] = {}
        self._depth: dict[str, Depth] = {}

    def _entry(self, key: str) -> dict[str, Any]:
        if key not in self._state:
            self._state[key] = {
                "symbol_key": key,
                "last": None,
                "prev_close": None,
                "change_pct": None,
                "bid": None,
                "ask": None,
                "open": None,
                "day_high": None,
                "day_low": None,
                "volume": None,
                "updated": None,
            }
        return self._state[key]

    def update_trade(self, ev: Trade) -> None:
        e = self._entry(ev.symbol_key)
        e["last"] = ev.price
        e["updated"] = ev.ts
        self._recompute(e)

    def update_quote(self, ev: Quote) -> None:
        # Deliberately no _recompute here: quotes move bid/ask, never `last`,
        # so change_pct cannot have changed since the trade/stats that set it.
        e = self._entry(ev.symbol_key)
        e["bid"], e["ask"] = ev.bid, ev.ask
        e["updated"] = ev.ts

    def update_stats(self, ev: StatsSnapshot) -> None:
        e = self._entry(ev.symbol_key)
        if ev.last is not None:
            e["last"] = ev.last
        for field in ("open", "prev_close", "day_high", "day_low",
                      "volume", "change_pct"):
            val = getattr(ev, field)
            if val is not None:
                e[field] = val
        e["updated"] = ev.ts
        self._recompute(e)

    def update_depth(self, ev: Depth) -> None:
        self._depth[ev.symbol_key] = ev

    def _recompute(self, e: dict[str, Any]) -> None:
        # `if last and prev` — a literal 0.0 is treated as "missing". True for
        # prices (no asset printed exactly 0 in our feeds); if a feed ever
        # sends a junk 0 tick it will fail-closed here, which is the lesser
        # evil vs dividing by a 0 prev_close for a fresh listing.
        last, prev = e.get("last"), e.get("prev_close")
        if last and prev:
            e["change_pct"] = round((last - prev) / prev * 100, 4)

    def get(self, key: str, default: dict[str, Any] | None = None) -> dict[str, Any] | None:
        return self._state.get(key, default)

    def depth(self, key: str) -> Depth | None:
        return self._depth.get(key)

    def snapshot(self) -> dict[str, Any]:
        return {k: dict(v) for k, v in self._state.items()}
