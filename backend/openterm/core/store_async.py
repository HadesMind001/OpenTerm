"""AsyncStore: the runtime's only window into SQLite.

Design (and the two-heads problem it lives with):
  * One `Store` instance (sync) owns reads-from-the-truth-table, all the CRUD
    helpers, and the schema. Its connection is shared across threads behind
    its own lock.
  * A background writer thread handles the HOT paths only — closed bars,
    equity samples — batching + coalescing commits so a tick storm doesn't
    fsync per event.
  * A tiny pool of dedicated read connections keeps chart/history reads off
    the writer's lock.

That's up to six connections against one file. What holds the chaos together
is SQLite WAL + busy_timeout on EVERY connection, and the rule: the writer
only ever enqueues (never awaited), and anything correctness-critical
(orders, fills, alerts) goes through the sync store immediately, accepting the
blocking-commit-on-event-loop cost that is documented in runtime.py.
"""
from __future__ import annotations

import itertools
import logging
import queue
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

from .store import BarRow, Store, _LEGACY_BAR_RENAMES, _SCHEMA

log = logging.getLogger(__name__)

# Bound the queue so a stalled writer (locked DB, failing disk) shows up as
# loud logs + a synchronous fallback instead of an OOM thirty minutes later.
_QUEUE_MAXSIZE = 20_000


class AsyncStoreWriter:
    """Background thread for batched, coalesced SQLite writes."""

    def __init__(self, path: Path, batch_interval: float = 0.1) -> None:
        self.path = path
        self.batch_interval = batch_interval
        self._queue: queue.Queue[tuple[str, Any] | None] = queue.Queue(
            maxsize=_QUEUE_MAXSIZE
        )
        self._thread: threading.Thread | None = None
        self._running = False
        self._conn: sqlite3.Connection | None = None
        self._dropped = 0

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="db-writer")
        self._thread.start()

    def stop(self) -> None:
        # Old code joined a thread that may never have started (RuntimeError)
        # and a second stop() re-joined a dead thread. Guard both.
        if not self._running:
            return
        self._running = False
        self._queue.put(None)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        if self._conn:
            try:
                self._conn.close()
            except sqlite3.Error:
                log.exception("writer conn close failed")
            self._conn = None
        self._thread = None

    def enqueue(self, op: tuple[str, Any]) -> None:
        # Called from the EVENT LOOP THREAD: must never block. On overflow
        # (DB wedged), drop the batch with an error log for bars (idempotent
        # upserts; the next seed/backfill heals) but equity points too — at
        # this point the DB is the problem, not the queue.
        try:
            self._queue.put_nowait(op)
        except queue.Full:
            self._dropped += 1
            if self._dropped % 50 == 1:
                log.error(
                    "db-writer queue FULL (%d ops dropped) — SQLite is stalled; "
                    "check for locked connections / disk trouble", self._dropped,
                )

    def flush(self, timeout: float = 5.0) -> None:
        """Block until all currently-queued operations are committed."""
        if not self._running:
            return
        done = threading.Event()
        self._queue.put(("_flush", done))
        if not done.wait(timeout=timeout):
            log.warning("db-writer flush timed out after %.1fs", timeout)

    def _run(self) -> None:
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.executescript(_SCHEMA)
        self._migrate_legacy_bars()

        batch: list[tuple[str, Any]] = []
        last_commit = time.time()

        while self._running:
            try:
                timeout = max(0.001, self.batch_interval - (time.time() - last_commit))
                op = self._queue.get(timeout=timeout)
                if op is None:
                    break
                if op[0] == "_flush":
                    if batch:
                        self._process_batch(batch)
                        batch.clear()
                    op[1].set()
                    last_commit = time.time()
                    continue
                batch.append(op)
                if len(batch) >= 100 or time.time() - last_commit >= self.batch_interval:
                    self._process_batch(batch)
                    batch.clear()
                    last_commit = time.time()
            except queue.Empty:
                if batch:
                    self._process_batch(batch)
                    batch.clear()
                    last_commit = time.time()
            except Exception:
                # A writer that dies silently is the worst possible outcome —
                # the queue just fills and everything degrades quietly. Keep
                # going, but make as much noise as the logging config allows.
                log.exception("AsyncStoreWriter iteration error")
                batch.clear()

        if batch:
            self._process_batch(batch)

    def _process_batch(self, batch: list[tuple[str, Any]]) -> None:
        if not batch or not self._conn:
            return
        try:
            upsert_bars_ops = [op for op in batch if op[0] == "upsert_bars"]
            other_ops = [op for op in batch if op[0] != "upsert_bars"]
            if upsert_bars_ops:
                all_rows: list[BarRow] = []
                for _, rows in upsert_bars_ops:
                    all_rows.extend(rows)
                self._conn.executemany(
                    "INSERT INTO bars(symbol_key, interval, ts, o, h, l, c, v) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(symbol_key, interval, ts) DO UPDATE SET "
                    "o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v",
                    all_rows,
                )
            for op_type, args in other_ops:
                if op_type == "add_equity_point":
                    self._conn.execute(
                        "INSERT INTO equity_points(ts, value) VALUES (?, ?) "
                        "ON CONFLICT(ts) DO UPDATE SET value = excluded.value",
                        args,
                    )
            self._conn.commit()
        except Exception:
            log.exception("db-writer batch failed (%d ops dropped after rollback)",
                          len(batch))
            if self._conn:
                self._conn.rollback()

    def _migrate_legacy_bars(self) -> None:
        if not self._conn:
            return
        cols = [r[1] for r in self._conn.execute("PRAGMA table_info(bars)")]
        renames = {
            old: new
            for old, new in _LEGACY_BAR_RENAMES.items()
            if old in cols and new not in cols
        }
        if not renames:
            return
        for old, new in renames.items():
            self._conn.execute(f"ALTER TABLE bars RENAME COLUMN {old} TO {new}")
        self._conn.commit()


class AsyncStore:
    """Runtime-facing store facade: sync helpers + background writer + read pool."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

        # Source of truth: schema, CRUD helpers, correctness-critical writes.
        self._sync_store = Store(self.path)

        self._writer = AsyncStoreWriter(self.path)
        self._writer.start()

        # Read pool. sqlite3.Connection is NOT thread-safe, so round-robin
        # hands each caller a different conn — but nothing stops two threads
        # getting the SAME conn when the pool size and request pattern line
        # up. Reads here are short and the GIL serializes statement stepping
        # well enough in practice; if you scale this, switch to
        # thread-local connections, not more cleverness in this method.
        self._read_conns: list[sqlite3.Connection] = []
        self._init_read_conns()

    def _init_read_conns(self, num: int = 4) -> None:
        for _ in range(num):
            conn = sqlite3.connect(str(self.path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            # WAL readers can still hit SQLITE_BUSY during a checkpoint;
            # without busy_timeout they raise immediately. The old pool had
            # no timeout and the old round-robin counter had no atomicity —
            # `idx += 1` races even with the GIL.
            conn.execute("PRAGMA busy_timeout=10000")
            self._read_conns.append(conn)
        self._read_cycle = itertools.cycle(self._read_conns)

    def _get_read_conn(self) -> sqlite3.Connection:
        # next() on itertools.cycle is atomic in CPython; no lock needed.
        return next(self._read_cycle)

    # ── reads ---------------------------------------------------------------

    def get_bars(
        self,
        symbol_key: str,
        interval: str,
        limit: int | None = None,
    ) -> list[dict]:
        conn = self._get_read_conn()
        sql = (
            "SELECT symbol_key, interval, ts, o, h, l, c, v FROM bars "
            "WHERE symbol_key = ? AND interval = ? ORDER BY ts DESC"
        )
        params: Sequence = [symbol_key, interval]
        if limit is not None:
            # Negative LIMIT means "unbounded" in SQLite — clamp defensively,
            # routes clamp too, belt and braces.
            sql += " LIMIT ?"
            params = [symbol_key, interval, max(1, min(int(limit), 5000))]
        rows = conn.execute(sql, params).fetchall()
        out = [
            {"ts": r["ts"], "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "v": r["v"]}
            for r in rows
        ]
        out.reverse()
        return out

    def last_bar_ts(self, symbol_key: str, interval: str) -> int | None:
        conn = self._get_read_conn()
        row = conn.execute(
            "SELECT MAX(ts) AS t FROM bars WHERE symbol_key = ? AND interval = ?",
            (symbol_key, interval),
        ).fetchone()
        return row["t"] if row and row["t"] is not None else None

    def equity_points(self, limit: int = 3000) -> list[tuple[float, float]]:
        conn = self._get_read_conn()
        rows = conn.execute(
            "SELECT ts, value FROM equity_points ORDER BY ts ASC LIMIT ?",
            (max(1, min(int(limit), 50_000)),),
        ).fetchall()
        return [(r["ts"], r["value"]) for r in rows]

    # ── hot-path writes (queued, may lag by up to batch_interval) ----------

    def upsert_bars(self, rows: Iterable[BarRow]) -> None:
        self._writer.enqueue(("upsert_bars", list(rows)))

    def add_equity_point(self, value: float) -> None:
        now = time.time()
        bucket = int(now // 30 * 30)
        self._writer.enqueue(("add_equity_point", (bucket, value)))

    # ── correctness-critical writes: synchronous, on the sync store --------
    # These run blocking commits on the event loop ON PURPOSE. A fill must be
    # durable before the response says "filled"; the queue would add a
    # 100ms+ window where a crash loses money-side state. Keep these rare.

    def insert_fill(
        self, order_id: int, symbol_key: str, side: str,
        qty: float, price: float, fee: float, ts: float
    ) -> int:
        return self._sync_store.insert_fill(order_id, symbol_key, side, qty, price, fee, ts)

    def symbols(self, list_name: str = "Main") -> list[tuple[str, int]]:
        return self._sync_store.symbols(list_name)

    def flush(self, timeout: float = 5.0) -> None:
        """Block until everything queued so far is committed (tests + shutdown)."""
        self._writer.flush(timeout)

    def close(self) -> None:
        self._writer.stop()
        for conn in self._read_conns:
            try:
                conn.close()
            except sqlite3.Error:
                log.exception("read conn close failed")
        self._sync_store.close()

    def __getattr__(self, name: str) -> Any:
        """Delegate everything not defined here (all CRUD helpers) to Store.

        The explicit methods above exist only where behavior differs from the
        sync store (queued hot writes, pooled reads). If you add a Store
        method, AsyncStore gets it automatically — that is the point.
        """
        return getattr(self._sync_store, name)
