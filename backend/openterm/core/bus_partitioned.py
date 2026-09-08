"""A sharded facade over EventBus.

READ THIS BEFORE PRAISING OR COPYING THE DESIGN:
Every real consumer subscribes "*" (the WS gateway does, and it is the only
consumer), and a "*" subscription must attach to every shard — so
`_shards_for_pattern` returns all shards, every event traverses one extra
queue hop, and the "partitioning" currently buys ZERO concurrency (publish is
synchronous in-process anyway; Python has no GIL-free win here) and zero
selectivity. What it DOES buy: 16 fan-in handles per connection and honest
reason for a future consumer to filter per-shard if a second subscriber type
ever appears. It is kept because ripping it out would touch the runtime and
every test for no measurable gain — but do not add features to it believing
it scales anything.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .bus import EventBus, Subscription


@dataclass
class Shard:
    bus: EventBus


class PartitionedEventBus:
    """Sharded EventBus facade; see module docstring for the honest caveats.

    Shards by symbol prefix (first 2 chars after namespace).
    e.g., "CRYPTO:BTCUSDT" -> hash("CR") % num_shards.
    NOTE: hash() is randomized per-process (PYTHONHASHSEED) — fine here since
    the mapping only has to be self-consistent within one run.
    """

    def __init__(self, num_shards: int = 16, maxsize: int = 8192) -> None:
        self.num_shards = num_shards
        self.shards: list[Shard] = [
            Shard(bus=EventBus(maxsize=maxsize)) for _ in range(num_shards)
        ]
        self._next_id = 0
        # sub.id -> list of (shard_idx, handle)
        self._handles: dict[int, list[tuple[int, Subscription]]] = {}

    def _shard_for_topic(self, topic: str) -> int:
        """Determine shard from topic. Format: 'tick:CRYPTO:BTCUSDT' or 'bar:EQUITY:AAPL:1m'"""
        parts = topic.split(":")
        if len(parts) >= 2:
            symbol_part = parts[1]
            if len(symbol_part) >= 2:
                return hash(symbol_part[:2]) % self.num_shards
        return hash(topic) % self.num_shards

    def _shards_for_pattern(self, pattern: str) -> list[int]:
        # Not laziness (though it looks like it): fnmatch patterns can match
        # ANY symbol prefix — "tick:*" has no shard-selective information —
        # so any subscription must attach to every shard to be correct.
        return list(range(self.num_shards))

    def publish(self, topic: str, event: Any) -> None:
        shard_idx = self._shard_for_topic(topic)
        self.shards[shard_idx].bus.publish(topic, event)

    def subscribe(self, pattern: str, maxsize: int | None = None) -> Subscription:
        self._next_id += 1
        queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize or 4096)
        sub = Subscription(id=self._next_id, pattern=pattern, queue=queue)
        handles: list[tuple[int, Subscription]] = []
        for shard_idx in self._shards_for_pattern(pattern):
            handle = self.shards[shard_idx].bus.share(pattern, queue)
            handles.append((shard_idx, handle))
        self._handles[sub.id] = handles
        return sub

    def unsubscribe(self, sub: "Subscription | int") -> None:
        sid = sub.id if isinstance(sub, Subscription) else sub
        for shard_idx, handle in self._handles.pop(sid, []):
            self.shards[shard_idx].bus.unsubscribe(handle)
