"""
OpenTerm Bot Manager — **EXPERIMENTAL / NON-FUNCTIONAL BY DESIGN (FOR NOW)**.

What this is: a local registry. Deployed strategy source is *persisted*,
state transitions and logs are recorded, and lifecycle events are published
on the EventBus so the browser can render the saga.

What this is NOT: an executor. **No bot code ever runs here.** start/stop
flip a state column and nothing else. The Rust WASM runtime lives in
`bot-runtime/` (also clearly labeled experimental: its CLI commands are stubs
and no guest module can be produced by anything in this repo yet). An earlier
version of this docstring claimed attachment "via the Unix-socket JSON-RPC
client in openterm_bot_runtime.transport" — no such Python module exists and
no client was ever written; the claim is deleted rather than wished upon.

Before wiring a real engine, read `bot-runtime/README.md` and the transport
framing notes there. The DB schema persists `source` since the schema-1
migration — before that, deploys literally threw the code away (audit-era
bug, kept in history so future-you doesn't reintroduce the "registry that
forgets" design).
"""

import ast
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from enum import Enum

from pydantic import BaseModel, Field

from ..core.events import BotEventMessage

log = logging.getLogger(__name__)

# Deployed sources are text persisted in SQLite; cap them so a paste-golf
# mistake can't balloon the DB. 256 KB is ~5000 lines of strategy.
_MAX_SOURCE_BYTES = 256 * 1024


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class BotState(str, Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    ERROR = "error"
    KILLED = "killed"


class BotLanguage(str, Enum):
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    RUST = "rust"
    ASSEMBLYSCRIPT = "assemblyscript"


class BotCapabilities(BaseModel):
    allowed_symbols: List[str] = Field(default_factory=lambda: ["*"])
    denied_symbols: List[str] = Field(default_factory=list)
    max_position_usd: float = 10000.0
    max_daily_loss_usd: float = 500.0
    max_drawdown_pct: float = 0.10
    can_place_orders: bool = True
    can_read_positions: bool = True
    can_emit_signals: bool = True
    can_access_market_data: bool = True
    max_orders_per_minute: int = 60
    max_memory_mb: int = 64
    max_fuel_per_callback: int = 10_000_000


class BotMetadata(BaseModel):
    name: str
    version: str = "1.0.0"
    language: BotLanguage = BotLanguage.PYTHON
    entrypoint: str = "Bot"
    description: Optional[str] = None
    author: Optional[str] = None


class BotManifest(BaseModel):
    bot: BotMetadata
    capabilities: BotCapabilities = Field(default_factory=BotCapabilities)
    config: Dict[str, Any] = Field(default_factory=dict)


class BotStats(BaseModel):
    callbacks_executed: int = 0
    orders_placed: int = 0
    orders_filled: int = 0
    signals_emitted: int = 0
    fuel_consumed: int = 0
    peak_memory_mb: int = 0
    last_error: Optional[str] = None


class BotInfo(BaseModel):
    bot_id: str
    name: str
    state: BotState
    started_at: Optional[str] = None
    stats: Dict[str, Any] = Field(default_factory=dict)
    config: Dict[str, Any] = Field(default_factory=dict)


class BotStatus(BaseModel):
    bot_id: str
    state: BotState
    started_at: Optional[str] = None
    last_heartbeat: Optional[str] = None
    error: Optional[str] = None
    stats: Dict[str, Any] = Field(default_factory=dict)


class BotLogEntry(BaseModel):
    timestamp: str
    level: str
    message: str


class ExampleInfo(BaseModel):
    id: str
    name: str
    description: str
    language: str
    source: str


def _examples_dir() -> Optional[Path]:
    candidates = [
        Path(__file__).resolve().parents[3] / "examples" / "bots",
        Path.cwd() / "examples" / "bots",
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return None


def _parse_example_meta(source: str, fallback: str) -> tuple[str, str]:
    """Pull (name, description) from a bot module docstring.

    Expects the first non-empty line to be the title; the next non-empty
    line (or the text after an em dash in the title) becomes the blurb.
    """
    doc = ""
    try:
        doc = ast.get_docstring(ast.parse(source)) or ""
    except Exception:
        doc = ""
    lines = [ln.strip() for ln in doc.splitlines() if ln.strip()]
    if not lines:
        return fallback, ""
    title = lines[0]
    if "—" in title:
        name, _, rest = title.partition("—")
        name = name.strip()
        desc = rest.strip().rstrip(".")
    else:
        name = title.rstrip(".").strip()
        desc = lines[1].rstrip(".") if len(lines) > 1 else ""
    return name, desc


_RISK_PRESETS: Dict[str, Dict[str, Any]] = {
    "conservative": {
        "max_position_usd": 5000.0,
        "max_daily_loss_usd": 200.0,
        "max_drawdown_pct": 0.05,
        "max_orders_per_minute": 30,
        "max_memory_mb": 32,
        "max_fuel_per_callback": 5_000_000,
    },
    "moderate": {},
    "aggressive": {
        "max_position_usd": 50000.0,
        "max_daily_loss_usd": 2000.0,
        "max_drawdown_pct": 0.20,
        "max_orders_per_minute": 120,
        "max_memory_mb": 128,
        "max_fuel_per_callback": 20_000_000,
    },
}


def _detect_language(source: str) -> BotLanguage:
    """Heuristic only — callers can always pass `language` explicitly.

    The old condition `A or B and C and D` silently parsed as
    `A or (B and C and D)` (Python's actual precedence — embarrassing but
    real), and the JS branch classified any Python file containing "import"
    without a "def " line in the first ten as JavaScript. Now: check the
    distinctive markers in strict order. Wrong guesses are cosmetic while
    the whole execution path is a registry anyway.
    """
    head = "\n".join(source.splitlines()[:10])
    if "use std::" in head or head.lstrip().startswith("#![") or "\nfn main" in head:
        return BotLanguage.RUST
    lowered = head.lower()
    if ("export " in head or "function " in head or "=>" in head) and "def " not in lowered:
        return BotLanguage.JAVASCRIPT
    return BotLanguage.PYTHON


class BotManager:
    """Local bot registry with SQLite persistence and EventBus publishing."""

    def __init__(self, runtime: Any = None):
        self.runtime = runtime
        self._bots: Dict[str, BotInfo] = {}
        self._stats: Dict[str, BotStats] = {}
        self._errors: Dict[str, str] = {}
        self._loaded = False

    # ── lifecycle ──────────────────────────────────────────────────────
    async def start(self) -> None:
        self._load()

    async def stop(self) -> None:
        for bot_id in list(self._bots):
            if self._bots[bot_id].state in (BotState.RUNNING, BotState.STARTING):
                try:
                    await self.stop_bot(bot_id)
                except Exception:
                    log.debug("bot %s failed to stop cleanly", bot_id, exc_info=True)

    def _store(self):
        return self.runtime.store

    def _load(self) -> None:
        if self._loaded or self.runtime is None:
            return
        try:
            for row in self._store().bots():
                try:
                    cfg = json.loads(row.get("config") or "{}")
                except Exception:
                    cfg = {}
                info = BotInfo(
                    bot_id=row["bot_id"],
                    name=row["name"],
                    state=row["state"],
                    started_at=None,
                    stats={},
                    config=cfg if isinstance(cfg, dict) else {},
                )
                self._bots[info.bot_id] = info
                self._stats[info.bot_id] = BotStats()
                # Anything that was mid-flight is stopped after a restart.
                if row["state"] in (BotState.RUNNING, BotState.STARTING):
                    self._set_state(info.bot_id, BotState.STOPPED)
        except Exception:
            # Registry load failure previously vanished silently and every
            # later operation then ran against an empty in-memory view —
            # deploys that "disappear" after restart. Loud debug, keep going.
            log.exception("bot registry failed to load from store")
        self._loaded = True

    # ── events & logs ──────────────────────────────────────────────────
    def _emit(self, bot_id: str, event: str, **data: Any) -> None:
        if self.runtime is None:
            return
        data.setdefault("bot_id", bot_id)
        self.runtime.bus.publish(
            f"bot:{bot_id}",
            BotEventMessage(symbol_key=bot_id, event=event, data=data),
        )

    def _log(self, bot_id: str, level: str, message: str) -> None:
        ts = _utc_iso()
        try:
            self._store().add_bot_log(bot_id, time.time(), level, message)
        except Exception:
            log.debug("bot log persist failed", exc_info=True)
        self._emit(
            bot_id, "LogEntry",
            entry={"timestamp": ts, "level": level, "message": message},
        )

    # ── state ──────────────────────────────────────────────────────────
    def _set_state(self, bot_id: str, state: BotState) -> BotInfo:
        info = self._bots[bot_id]
        info.state = state
        try:
            self._store().set_bot_state(bot_id, state.value, time.time())
        except Exception:
            log.debug("bot state persist failed", exc_info=True)
        return info

    # ── public API ─────────────────────────────────────────────────────
    async def deploy_bot(
        self,
        source: str,
        name: Optional[str] = None,
        risk: str = "moderate",
        language: Optional[str] = None,
        force: bool = False,
    ) -> BotInfo:
        if self.runtime is None:
            raise RuntimeError("BotManager not wired to runtime")
        self._load()
        if not source or not source.strip():
            raise ValueError("source is empty")
        if len(source.encode("utf-8", errors="replace")) > _MAX_SOURCE_BYTES:
            raise ValueError(f"source exceeds {_MAX_SOURCE_BYTES // 1024} KB")
        if risk not in _RISK_PRESETS:
            raise ValueError(f"unknown risk preset '{risk}'")

        bot_id = str(uuid.uuid4())[:8]
        display = (name or "strategy").strip()[:48] or "strategy"
        lang = language or _detect_language(source).value

        caps = BotCapabilities(**_RISK_PRESETS.get(risk, {}))
        manifest = BotManifest(
            bot=BotMetadata(name=display, language=lang),  # type: ignore[arg-type]
            capabilities=caps,
        )

        info = BotInfo(bot_id=bot_id, name=display, state=BotState.STOPPED, stats={})
        self._bots[bot_id] = info
        self._stats[bot_id] = BotStats()
        try:
            # `source` now actually reaches the DB (schema v1 added the
            # column; the deploy path used to accept source and discard it,
            # which made every "deploy" a memory of a memory).
            self._store().upsert_bot(
                bot_id,
                display,
                BotState.STOPPED.value,
                manifest.model_dump_json(),
                "{}",
                time.time(),
                time.time(),
                source=source,
            )
        except Exception:
            log.exception("bot deploy persistence FAILED for %s", bot_id)
            raise RuntimeError("could not persist bot; deploy refused") 

        self._log(bot_id, "info", f"Deployed '{display}' (risk={risk}, language={lang})")
        self._emit(bot_id, "BotDeployed", name=display)
        return info

    async def deploy_example(self, example_id: str, risk: str = "moderate") -> BotInfo:
        for ex in await self.list_examples():
            if ex.id == example_id:
                return await self.deploy_bot(
                    source=ex.source, name=ex.name, risk=risk, language=ex.language,
                )
        raise ValueError(f"unknown example: {example_id}")

    async def start_bot(self, bot_id: str) -> BotInfo:
        self._load()
        if bot_id not in self._bots:
            raise ValueError(f"unknown bot: {bot_id}")
        info = self._set_state(bot_id, BotState.RUNNING)
        info.started_at = _utc_iso()
        self._errors.pop(bot_id, None)
        self._log(bot_id, "warn",
                  "state=running (EXPERIMENTAL: registry-only; no code executes)")
        self._emit(bot_id, "BotStarted")
        self._emit(bot_id, "Heartbeat", stats=self._stats[bot_id].model_dump())
        return info

    async def stop_bot(self, bot_id: str) -> BotInfo:
        self._load()
        if bot_id not in self._bots:
            raise ValueError(f"unknown bot: {bot_id}")
        info = self._set_state(bot_id, BotState.STOPPED)
        self._log(bot_id, "info", "Bot stopped")
        self._emit(bot_id, "BotStopped")
        return info

    async def restart_bot(self, bot_id: str) -> BotInfo:
        await self.stop_bot(bot_id)
        return await self.start_bot(bot_id)

    async def delete_bot(self, bot_id: str) -> bool:
        self._load()
        if bot_id in self._bots and self._bots[bot_id].state == BotState.RUNNING:
            await self.stop_bot(bot_id)
        removed = False
        try:
            removed = self._store().delete_bot(bot_id)
        except Exception:
            log.debug("bot delete persist failed", exc_info=True)
        self._bots.pop(bot_id, None)
        self._stats.pop(bot_id, None)
        return removed

    async def stop_all_bots(self) -> None:
        for bot_id in list(self._bots):
            if self._bots[bot_id].state == BotState.RUNNING:
                await self.stop_bot(bot_id)

    async def list_examples(self) -> List[ExampleInfo]:
        d = _examples_dir()
        if d is None:
            return []
        out: List[ExampleInfo] = []
        for path in sorted(d.glob("*.py")):
            try:
                source = path.read_text(encoding="utf-8")
            except Exception:
                continue
            name, desc = _parse_example_meta(source, path.stem)
            out.append(
                ExampleInfo(
                    id=path.stem,
                    name=name,
                    description=desc,
                    language=_detect_language(source).value,
                    source=source,
                )
            )
        return out

    async def list_bots(self) -> List[BotInfo]:
        self._load()
        return [
            BotInfo(**{**b.model_dump(), "stats": self._stats.get(b.bot_id, BotStats()).model_dump()})
            for b in self._bots.values()
        ]

    async def get_bot_status(self, bot_id: str) -> BotStatus:
        self._load()
        if bot_id not in self._bots:
            raise ValueError(f"unknown bot: {bot_id}")
        info = self._bots[bot_id]
        return BotStatus(
            bot_id=bot_id,
            state=info.state,
            started_at=info.started_at,
            error=self._errors.get(bot_id),
            stats=self._stats.get(bot_id, BotStats()).model_dump(),
        )

    async def get_bot_logs(self, bot_id: str, lines: int = 200) -> List[BotLogEntry]:
        try:
            rows = self._store().bot_logs(bot_id, limit=max(1, min(lines, 500)))
        except Exception:
            log.debug("bot log read failed", exc_info=True)
            rows = []
        return [
            BotLogEntry(
                timestamp=datetime.fromtimestamp(r["ts"], tz=timezone.utc).isoformat(),
                level=r["level"],
                message=r["message"],
            )
            for r in rows
        ]

    async def update_bot_config(self, bot_id: str, config: Dict[str, Any]) -> BotInfo:
        self._load()
        if bot_id not in self._bots:
            raise ValueError(f"unknown bot: {bot_id}")
        info = self._bots[bot_id]
        info.config = config
        try:
            store = self._store()
            for row in store.bots():
                if row["bot_id"] == bot_id:
                    store.upsert_bot(
                        bot_id, row["name"], row["state"], row["manifest"],
                        json.dumps(config), row["created"], time.time(),
                        source=row.get("source") or "",
                    )
                    break
        except Exception:
            log.debug("bot config persist failed", exc_info=True)
        self._log(bot_id, "info", "Config updated")
        self._emit(bot_id, "ConfigChanged", config=config)
        return info

