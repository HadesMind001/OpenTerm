"""News via Google News RSS — the "no key, no mercy" provider.

Despite the name, this is NOT the GNewsAPI product: it scrapes
news.google.com/rss/search, the public RSS endpoints. That choice is
deliberate: no API key to configure, no quota meter to babysit, and it works
on a fresh install with zero setup. The flip side of unofficial: the feed
format is undocumented, undocumented changes are silent, and when it breaks
there is no status page to blame and no ticket to open.

Degradation map, so nobody is surprised later:
- One _fetch dying must not kill the batch: poll() gathers with
  return_exceptions=True, so a 500 on one ticker's query costs exactly that
  ticker's news for this cycle (retried next 120s pass). The catch, stated
  honestly: that same swallow means poll() never raises when every query
  fails, so _loop's set_status(True) keeps the health dot green on a fully
  silent feed. Trust the news pane, not the dot.
- A titleless item is dropped outright (the dedup key falls back
  guid→link→title, and a story with no title has nothing to show anyway).
- pubDate unparseable → stamped now: a misplaced date shows the story at the
  wrong end of the feed; dropping it makes the story not exist. Wrong end of
  the feed wins.
"""

from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

from ..core.events import NewsItem
from .base import Provider

RSS = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
MARKET_QUERY = "stock market OR federal reserve OR inflation"


class GNewsProvider(Provider):
    name = "gnews"
    capabilities = frozenset({"news"})
    poll_interval = 120.0

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Dict-as-ordered-set: the old set[str] + `list(self._seen)[-2000:]`
        # "trim" evicted an ARBITRARY 3000 guides because sets are unordered —
        # guaranteed duplicates of the stories you kept, forever. Insertion
        # order = arrival order = proper FIFO memory.
        self._seen: dict[str, None] = {}

    async def poll(self) -> None:
        tasks = [asyncio.create_task(self._fetch(MARKET_QUERY))]
        for inst in self.watched.values():
            if inst.asset_class == "EQUITY":
                tasks.append(asyncio.create_task(self._fetch(inst)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _fetch(self, target) -> None:
        query = (
            MARKET_QUERY
            if isinstance(target, str)
            else f"{target.ticker} stock OR {target.ticker} shares"
        )
        url = RSS.format(q=quote_plus(query))
        resp = await self.http.get(url, follow_redirects=True)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        channel = root.find("channel")
        items = channel.findall("item") if channel is not None else []
        # 12 per query per cycle: RSS can hand back dozens, the UI deque is
        # 200 per symbol, and one linkbait storm shouldn't evict a day of
        # real headlines before the next poll can spread them out.
        for item in items[:12]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            guid = item.findtext("guid") or link or title
            if not title or guid in self._seen:
                continue
            self._seen[guid] = None
            if len(self._seen) > 5000:
                for stale in list(self._seen)[:3000]:
                    del self._seen[stale]
            src_node = item.find("source")
            pub_raw = item.findtext("pubDate")
            try:
                published = (
                    parsedate_to_datetime(pub_raw).astimezone(timezone.utc)
                    if pub_raw
                    else datetime.now(timezone.utc)
                )
            except (TypeError, ValueError):
                published = datetime.now(timezone.utc)
            key = "" if isinstance(target, str) else target.key
            topic = f"news:{key}" if key else "news:MARKET"
            self.bus.publish(
                topic,
                NewsItem(
                    symbol_key=key,
                    feed="GNEWS",
                    headline=title,
                    url=link,
                    source=(src_node.text or src_node.get("url", "") if src_node is not None else "") or "Google News",
                    summary="",
                    published=published,
                ),
            )
