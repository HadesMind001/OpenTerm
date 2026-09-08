from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import Iterable

import httpx

from ..core.bus import EventBus
from ..core.events import ProviderStatus
from ..core.symbols import Instrument

log = logging.getLogger(__name__)

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) OpenTerm/0.1"

# Belt-and-braces redaction for anything that echoes an exception into status
# details or logs (ProviderHTTPError keeps them clean, but third-party libs
# invent their own messages daily).
_SECRET_QUERY_RE = re.compile(r"(?i)(token|api[_-]?key|apikey|access_token|secret)=[^&\s'\"]+")


def _redact_secrets(text: str) -> str:
    return _SECRET_QUERY_RE.sub(r"\1=[REDACTED]", text or "")


class ProviderHTTPError(Exception):
    """HTTP failure WITHOUT the request URL in the message.

    Why a bespoke class: httpx's HTTPStatusError str() embeds the full request
    URL, and finnhub/polygon/FRED all pass the API key as a query parameter.
    That string ends up in log files (world-readable /tmp during dev), in
    ProviderStatus.detail broadcast over the WS, and anywhere an exception
    repr is printed. A leaked key is a paid-for incident. So provider clients
    raise THIS, whose message is just "finnhub: HTTP 401".
    """

    def __init__(self, provider: str, status_code: int) -> None:
        self.provider = provider
        self.status_code = status_code
        super().__init__(f"{provider}: HTTP {status_code}")


def check_status(resp, provider: str) -> None:
    """raise_for_status(), but see ProviderHTTPError for why it isn't raw."""
    if resp.status_code >= 400:
        raise ProviderHTTPError(provider, resp.status_code)


class Provider:
    """Base class for data-source adapters.

    Two styles:
      - streaming: override ``run()`` (long-lived websocket); raise to reconnect.
      - polling:   set ``poll_interval`` and override ``poll()``.

    Failures never propagate; they surface as ProviderStatus events that drive
    the UI health dots, with exponential backoff between attempts.
    """

    name = "base"
    capabilities: frozenset[str] = frozenset()
    poll_interval: float | None = None
    max_backoff = 30.0

    def __init__(self, bus: EventBus, http: httpx.AsyncClient | None = None) -> None:
        self.bus = bus
        self.http = http or httpx.AsyncClient(
            timeout=10.0, headers={"User-Agent": USER_AGENT}
        )
        self.watched: dict[str, Instrument] = {}
        self.running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self.running = True
        self._task = asyncio.create_task(self._loop(), name=f"provider:{self.name}")

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                # The expected path: we cancelled it, it honoured that.
                pass
            except Exception:
                # A crash inside _loop that ISN'T cancellation. Do NOT swallow
                # this into the CancelledError branch like the old
                # `except (asyncio.CancelledError, Exception)` did — that also
                # swallowed OUR OWN cancellation while awaiting, so a timeout
                # on shutdown got silently converted into "provider stopped".
                log.exception("provider %s terminated with an error", self.name)
            self._task = None

    async def set_watched(self, instruments: Iterable[Instrument]) -> None:
        new_map = {i.key: i for i in instruments}
        changed = set(new_map) != set(self.watched)
        self.watched = new_map
        if changed:
            await self.on_watched_changed()

    async def on_watched_changed(self) -> None:  # pragma: no cover - hook
        pass

    async def run(self) -> None:  # pragma: no cover - override for streaming
        await asyncio.sleep(3600)

    async def poll(self) -> None:  # pragma: no cover - override for polling
        pass

    async def _loop(self) -> None:
        backoff = 1.0
        while self.running:
            try:
                if self.poll_interval is None:
                    await self.run()
                    if not self.running:
                        break
                    backoff = 1.0
                else:
                    await self.poll()
                    self.set_status(True)
                    await asyncio.sleep(self.poll_interval)
                    backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.set_status(False, str(exc))
                log.warning("provider %s error: %s", self.name, exc)
                # Jitter up to ±25%: without it, after a network blip every
                # provider (and every reload) reconnects on the same tick —
                # thundering herd onto an already-unwell upstream.
                delay = min(backoff, self.max_backoff) * random.uniform(0.75, 1.25)
                await asyncio.sleep(delay)
                backoff = min(backoff * 2, self.max_backoff)

    def set_status(self, connected: bool, detail: str = "") -> None:
        self.bus.publish(
            f"status:{self.name}",
            ProviderStatus(name=self.name, connected=connected,
                           # REDACT first, then cap: truncating first can slice
                           # a token mid-string and dodge the regex entirely.
                           detail=_redact_secrets(detail)[:200]),
        )
