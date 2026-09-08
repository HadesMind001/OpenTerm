from __future__ import annotations

import asyncio
import fnmatch
from dataclasses import dataclass
from typing import Any


@dataclass
class Subscription:
    id: int
    pattern: str
    queue: asyncio.Queue | None = None
    dropped: int = 0


class EventBus:
    """Topic-string pub/sub with fnmatch wildcard patterns.

    Each subscriber owns a bounded queue; when it falls behind the oldest
    event is dropped and a counter bumped so slow consumers never block
    publishers.
    """

    def __init__(self, maxsize: int = 4096) -> None:
        self._subs: dict[int, Subscription] = {}
        self._next_id = 0
        self._maxsize = maxsize

    def subscribe(self, pattern: str, maxsize: int | None = None) -> Subscription:
        self._next_id += 1
        sub = Subscription(id=self._next_id, pattern=pattern)
        sub.queue = asyncio.Queue(maxsize=maxsize or self._maxsize)
        self._subs[sub.id] = sub
        return sub

    def share(self, pattern: str, queue: asyncio.Queue) -> Subscription:
        """Register a subscription that delivers into an externally-owned queue.

        Used by PartitionedEventBus so one logical subscriber can attach to
        several shard buses and share a single queue.
        """
        self._next_id += 1
        sub = Subscription(id=self._next_id, pattern=pattern, queue=queue)
        self._subs[sub.id] = sub
        return sub

    def unsubscribe(self, sub: "Subscription | int") -> None:
        sid = sub.id if isinstance(sub, Subscription) else sub
        self._subs.pop(sid, None)

    def publish(self, topic: str, event: Any) -> None:
        for sub in list(self._subs.values()):
            if not fnmatch.fnmatchcase(topic, sub.pattern):
                continue
            q = sub.queue
            try:
                q.put_nowait((topic, event))
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                sub.dropped += 1
                try:
                    q.put_nowait((topic, event))
                except asyncio.QueueFull:
                    pass

    async def get(self, sub: Subscription) -> tuple[str, Any]:
        return await sub.queue.get()

    def get_nowait(self, sub: Subscription) -> tuple[str, Any] | None:
        try:
            return sub.queue.get_nowait()
        except asyncio.QueueEmpty:
            return None
