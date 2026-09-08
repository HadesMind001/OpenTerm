from __future__ import annotations

import asyncio
import logging
from collections import deque
from pathlib import Path
from typing import Any

import httpx

from .core.bus import EventBus
from .core.bus_partitioned import PartitionedEventBus
from .core.config import Settings, load_settings
from .core.events import (
    AlertEvent,
    Bar,
    Depth,
    FillEvent,
    NewsItem,
    ProviderStatus,
    Quote,
    StatsSnapshot,
    Trade,
)
from .core.symbols import from_key, ASSET_EQUITY, Instrument
from .services.marketstate import MarketState
from .core.store_async import AsyncStore
from .providers.alpaca import AlpacaClient
from .providers.binance_ws import BinanceProvider
from .providers.finnhub import FinnhubClient
from .providers.fred import FredProvider
from .providers.gnews import GNewsProvider
from .providers.oanda import OandaProvider
from .providers.polygon import PolygonClient
from .providers.yahoo import YahooProvider
from .services.alerts import AlertEngine
from .services.bars import BarBuilder
from .services.bot_manager import BotManager
from .services.broker import Broker
from .services.history import HistoryService
from .services.scripting import ScriptingService
from .services.screener import DEFAULT_UNIVERSE
from .services.universe import UniverseMeta

log = logging.getLogger(__name__)

DEFAULT_DB = Path.home() / ".local" / "share" / "openterm" / "openterm.db"

# BarBuilder intervals whose open buckets survive a restart via seeding.
_SEED_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")


class Runtime:
    """Owns the bus, services, providers; runs the dispatch loop."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        with_providers: bool = True,
        settings: Settings | None = None,
    ) -> None:
        self.bus = PartitionedEventBus(num_shards=16)
        self.store = AsyncStore(db_path or DEFAULT_DB)
        self.market_state = MarketState()
        self.bar_builder = BarBuilder(self.bus)
        http = httpx.AsyncClient(
            timeout=10.0,
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) OpenTerm/0.1"},
            follow_redirects=True,
        )
        self.http = http
        self.settings = settings or load_settings()
        self.binance = BinanceProvider(self.bus, http)
        self.yahoo = YahooProvider(self.bus, http)
        self.gnews = GNewsProvider(self.bus, http)
        self.providers: list[Any] = (
            [self.binance, self.yahoo, self.gnews] if with_providers else []
        )
        self.finnhub: FinnhubClient | None = None
        self.polygon: PolygonClient | None = None
        self.fred: FredProvider | None = None
        if with_providers:
            if self.settings.finnhub_key:
                self.finnhub = FinnhubClient(self.settings.finnhub_key, http)
            if self.settings.polygon_key:
                self.polygon = PolygonClient(self.settings.polygon_key, http)
            if self.settings.fred_key:
                self.fred = FredProvider(self.bus, http,
                                         key=self.settings.fred_key)
                self.providers.append(self.fred)
            if self.settings.oanda_token and self.settings.oanda_account:
                self.providers.append(
                    OandaProvider(
                        self.bus,
                        http,
                        token=self.settings.oanda_token,
                        account=self.settings.oanda_account,
                    )
                )
        self.history = HistoryService(
            self.store, self.binance, self.yahoo, polygon=self.polygon
        )
        self.broker = Broker(self.bus, self.store, self.market_state)
        self.alpaca: AlpacaClient | None = None
        if with_providers and self.settings.alpaca_key_id and self.settings.alpaca_secret_key:
            self.alpaca = AlpacaClient(
                self.settings.alpaca_key_id,
                self.settings.alpaca_secret_key,
                http,
            )
        self.alerts = AlertEngine(self.bus, self.store)
        # Was: get_engine() from services/correlation.py — a "streaming
        # correlation" engine whose update() compared a price against a stored
        # return (yes, really), fed 1.0+r price factors from the routes, and
        # consumed by nobody. The REST correlation endpoints now compute
        # honestly from bars. Do not resurrect it.
        self.scripting = ScriptingService()
        self.bot_manager = BotManager(self)
        self.universe_meta = UniverseMeta(self.finnhub, http)
        self.news: dict[str, deque[NewsItem]] = {}
        self.provider_status: dict[str, bool] = {}
        self._watched: dict[str, tuple[Instrument, set[str]]] = {}
        self._dispatch_tasks: list[asyncio.Task] = []
        self._equity_task: asyncio.Task | None = None
        # Strong refs for fire-and-forget tasks. asyncio only keeps weak refs
        # to tasks — without this, CPython is free to GC a mid-flight refresh
        # and you get "coroutine was garbage collected" gremlins.
        self._bg: set[asyncio.Task] = set()
        self._push_task: asyncio.Task | None = None
        self._push_dirty = False
        self.with_providers = with_providers

    def _spawn_bg(self, coro: Any, name: str = "") -> asyncio.Task:
        task = asyncio.create_task(coro, name=name)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)
        return task

    async def start(self) -> None:
        for key, _ in self.store.symbols("Main"):
            inst = from_key(key)
            if inst:
                self._watch(inst.key, inst, "watchlist")
        for key in DEFAULT_UNIVERSE:
            inst = from_key(key)
            if inst:
                self._watch(inst.key, inst, "screen")
        await self.push_watched()
        # Restore in-progress rollup buckets BEFORE any provider can emit,
        # or the first closed bar of the session clobbers a half-filled one.
        for key in list(self._watched):
            for iv in _SEED_INTERVALS:
                rows = self.store.get_bars(key, iv, limit=1)
                if rows:
                    self.bar_builder.seed(key, iv, rows[-1])
        for p in self.providers:
            await p.start()
        await self.bot_manager.start()
        if self.finnhub is not None:
            await self.universe_meta.start(self._watched_equity_keys)
            keys = self._watched_equity_keys() or DEFAULT_UNIVERSE
            # Reference kept via _spawn_bg: a bare create_task can be garbage
            # collected mid-HTTP and nobody would ever notice the universe
            # metadata silently stopped refreshing.
            self._spawn_bg(self.universe_meta.refresh(keys), name="universe-refresh")
        # Create one dispatch task per shard
        for shard_idx in range(self.bus.num_shards):
            task = asyncio.create_task(self._dispatch_loop(shard_idx))
            self._dispatch_tasks.append(task)
        self._equity_task = asyncio.create_task(self._equity_loop())

    async def stop(self) -> None:
        await self.bot_manager.stop()
        await self.universe_meta.stop()
        if self._push_task and not self._push_task.done():
            self._push_task.cancel()
        for task in list(self._bg):
            task.cancel()
        for task in self._dispatch_tasks:
            task.cancel()
        for task in self._dispatch_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                # A dispatch loop should only die on cancel; anything else is
                # a bug worth seeing in the log at shutdown.
                log.exception("dispatch loop died with an error")
        if self._equity_task:
            self._equity_task.cancel()
            try:
                await self._equity_task
            except asyncio.CancelledError:
                pass
        for p in self.providers:
            await p.stop()
        await self.http.aclose()
        self.store.close()

    async def push_watched(self) -> None:
        instruments = [inst for inst, _ in self._watched.values()]
        if not self.with_providers:
            return
        # Push to ALL providers, not a hard-coded trio. The old tuple
        # (binance, yahoo, gnews) meant OandaProvider.watched was *permanently*
        # empty and its run() slept forever — FX streaming advertised in the
        # README, dead on arrival, no error anywhere. Any provider added later
        # would have made the same mistake.
        for p in self.providers:
            await p.set_watched(instruments)

    async def apply_settings(self, s: Settings) -> None:
        """Hot-swap provider keys saved from the UI — no restart needed.

        Rule: whenever the key VALUE changed, rebuild the client. The previous
        version only built clients when the attribute was None, so saving a
        corrected key kept using the stale one while /settings cheerfully
        reported "applied live". Rotation now actually rotates.
        """
        old = self.settings
        self.settings = s

        # --- finnhub -------------------------------------------------------
        if s.finnhub_key and self.finnhub is None:
            self.finnhub = FinnhubClient(s.finnhub_key, self.http)
            self.universe_meta.finnhub = self.finnhub
            if self.with_providers:
                await self.universe_meta.start(self._watched_equity_keys)
                self._spawn_bg(
                    self.universe_meta.refresh(self._watched_equity_keys()),
                    name="universe-refresh",
                )
        elif s.finnhub_key and s.finnhub_key != old.finnhub_key:
            self.finnhub = FinnhubClient(s.finnhub_key, self.http)
            self.universe_meta.finnhub = self.finnhub
        elif not s.finnhub_key and self.finnhub is not None:
            self.finnhub = None
            self.universe_meta.finnhub = None

        # --- polygon / alpaca (pure clients, no loops) ---------------------
        if s.polygon_key and s.polygon_key != (old.polygon_key if self.polygon else ""):
            self.polygon = PolygonClient(s.polygon_key, self.http)
            self.history.polygon = self.polygon
        elif not s.polygon_key:
            self.polygon = None
            self.history.polygon = None

        if not self.with_providers:
            return

        want_alpaca = bool(s.alpaca_key_id and s.alpaca_secret_key)
        if want_alpaca and (self.alpaca is None or s.alpaca_key_id != old.alpaca_key_id):
            self.alpaca = AlpacaClient(s.alpaca_key_id, s.alpaca_secret_key, self.http)
        elif not want_alpaca:
            self.alpaca = None

        def running(name: str) -> Any | None:
            return next((p for p in self.providers if p.name == name), None)

        # --- fred (streaming-ish provider with its own loop) ---------------
        fred = running("fred")
        if s.fred_key and (fred is None or s.fred_key != old.fred_key):
            if fred is not None:
                await fred.stop()
                self.providers.remove(fred)
            self.fred = FredProvider(self.bus, self.http, key=s.fred_key)
            self.providers.append(self.fred)
            await self.fred.start()
        elif not s.fred_key:
            if fred:
                await fred.stop()
                self.providers.remove(fred)
            self.fred = None

        # --- oanda -----------------------------------------------------------
        want_oanda = bool(s.oanda_token and s.oanda_account)
        oanda = running("oanda")
        rotate_oanda = want_oanda and oanda is not None and (
            s.oanda_token != old.oanda_token or s.oanda_account != old.oanda_account
        )
        if want_oanda and (oanda is None or rotate_oanda):
            if oanda is not None:
                await oanda.stop()
                self.providers.remove(oanda)
            provider = OandaProvider(
                self.bus,
                self.http,
                token=s.oanda_token,
                account=s.oanda_account,
            )
            self.providers.append(provider)
            await provider.start()
            # A freshly started provider has an EMPTY watched map; without
            # this push, OANDA sleeps until the user touches their watchlist.
            # (Yes — this is the same class of bug as push_watched skipping
            # oanda entirely. The fix for "who feeds set_watched" is: everyone,
            # right after construction.)
            await provider.set_watched(
                [inst for inst, _ in self._watched.values()]
            )
        elif not want_oanda and oanda is not None:
            await oanda.stop()
            self.providers.remove(oanda)

    def watch(self, keys: list[str], tag: str) -> None:
        for key in keys:
            inst = from_key(key)
            if not inst:
                continue
            self._watch(key, inst, tag)
        self._schedule_push()

    def unwatch(self, keys: list[str], tag: str) -> None:
        for key in keys:
            entry = self._watched.get(key)
            if entry and tag in entry[1]:
                entry[1].discard(tag)
                if not entry[1]:
                    del self._watched[key]
        self._schedule_push()

    def _schedule_push(self) -> None:
        """Coalescing push of the watched set to providers.

        One push_watched() per burst of watch/unwatch calls, not one task per
        call. Nave push tasks race on replacing provider.watched while a
        websocket resubscribe is mid-flight; and spawning a task per click
        without holding a reference is the GC hazard the asyncio docs warn
        about in ALL CAPS.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._push_task is not None and not self._push_task.done():
            self._push_dirty = True
            return
        self._push_dirty = False
        self._push_task = loop.create_task(self._push_worker(), name="push-watched")

    async def _push_worker(self) -> None:
        try:
            await self.push_watched()
            while self._push_dirty:
                self._push_dirty = False
                await self.push_watched()
        finally:
            # Single-threaded asyncio: clearing _push_task here without an
            # intervening await means no _schedule_push() call can slip in
            # while we decide whether to relaunch below.
            self._push_task = None
        if self._push_dirty:
            # A watch() arrived during our very last push; run one more round.
            self._schedule_push()

    def _watch(self, key: str, inst: Instrument, tag: str) -> None:
        if key in self._watched:
            self._watched[key][1].add(tag)
        else:
            self._watched[key] = (inst, {tag})

    def _watched_equity_keys(self) -> list[str]:
        return [
            key
            for key, (inst, _tags) in self._watched.items()
            if inst.asset_class == ASSET_EQUITY
        ]

    async def _dispatch_loop(self, shard_idx: int) -> None:
        # One task per shard, subscribing the RAW shard bus (not the facade)
        # so each shard drains its OWN queue. Be exact about what that buys,
        # because it is less than it sounds: handle() is fully synchronous
        # and all 16 tasks run on one event-loop thread, so a slow handler
        # blocks the whole loop and every queue backs up anyway. What the
        # per-shard queues DO isolate is the drop blast radius — bounded
        # per shard, so a flood on one shard can't eat another's queue —
        # but note that tick:CRYPTO:* topics all hash to the same shard
        # (first 2 chars of parts[1], see bus_partitioned), so in practice
        # the isolation is per asset class, plus whatever luck the seed
        # gave you. It does NOT buy parallelism; read bus_partitioned's
        # module docstring before believing otherwise.
        # The load-bearing rule for handle(): stay synchronous-cheap. Every
        # microsecond it burns is backlog everywhere, and subscriber queues
        # are bounded — a full queue drops the OLDEST events and silently
        # bumps sub.dropped, which nobody reads. A consistently slow handler
        # doesn't make the UI laggy, it makes events nonexistent, and only
        # the gap in your charts will ever notice.
        sub = self.bus.shards[shard_idx].bus.subscribe("*", maxsize=10000)
        while True:
            topic, event = await sub.queue.get()
            try:
                self.handle(topic, event)
            except Exception:
                log.exception("dispatch error on %s", topic)

    def handle(self, topic: str, event: Any) -> None:
        # FillEvent/AlertEvent are OUTPUTS of this very function: broker
        # publishes fills from inside the Trade branch below, the alert
        # engine publishes from on_trade/on_bar. The bus faithfully loops
        # them back into a dispatch queue (the fill even lands on the same
        # shard as its symbol's ticks), and here we faithfully ignore them
        # — the ws gateway is the consumer; dispatch must not react to its
        # own exhaust. Today they'd match no isinstance branch anyway, so
        # the filter is cheap insurance, not magic: the day someone adds a
        # fill- or alert-reactive handler, this line is what decides whether
        # that feature is a loop or a function. Note Bar is deliberately
        # NOT filtered — re-entry of closed bars is the persistence path.
        if isinstance(event, (FillEvent, AlertEvent)):
            return
        if isinstance(event, Trade):
            self.market_state.update_trade(event)
            self.bar_builder.update(event)
            try:
                # broker.on_tick may synchronously COMMIT to SQLite from the
                # event loop. That stalls every coroutine until it returns —
                # measured: a fill costs ~1ms with WAL, so it is survivable,
                # but this is the one real blocking-IO-on-loop in the app.
                # Moving broker writes through AsyncStore's writer thread is
                # the proper fix and is deliberately NOT done here because
                # it turns the fill path async across ~15 call sites.
                self.broker.on_tick(event)
                self.alerts.on_trade(event)
            except Exception:
                log.exception("dispatch tick error")
        elif isinstance(event, Quote):
            self.market_state.update_quote(event)
        elif isinstance(event, Depth):
            self.market_state.update_depth(event)
        elif isinstance(event, StatsSnapshot):
            self.market_state.update_stats(event)
        elif isinstance(event, Bar) and event.closed:
            self.store.upsert_bars(
                [(event.symbol_key, event.interval, event.ts,
                  event.o, event.h, event.l, event.c, event.v)]
            )
            if event.interval == "1m":
                try:
                    self.alerts.on_bar(event)
                except Exception:
                    log.exception("alert bar error")
        elif isinstance(event, NewsItem):
            bucket = self.news.setdefault(event.symbol_key or "MARKET",
                                          deque(maxlen=200))
            bucket.appendleft(event)
        elif isinstance(event, ProviderStatus):
            self.provider_status[event.name] = event.connected

    async def _equity_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                self.store.add_equity_point(self.broker.portfolio()["equity"])
            except Exception:
                log.exception("equity sample error")

    def statuses(self) -> dict[str, bool]:
        return dict(self.provider_status)