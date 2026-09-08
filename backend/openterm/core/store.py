from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable, Sequence

_SCHEMA = """
CREATE TABLE IF NOT EXISTS watchlists(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist_items(
  list_id INTEGER NOT NULL REFERENCES watchlists(id),
  symbol_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added REAL NOT NULL,
  PRIMARY KEY(list_id, symbol_key)
);
CREATE TABLE IF NOT EXISTS bars(
  symbol_key TEXT NOT NULL,
  interval TEXT NOT NULL,
  ts INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  v REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(symbol_key, interval, ts)
);
CREATE INDEX IF NOT EXISTS idx_bars_lookup ON bars(symbol_key, interval, ts);
CREATE TABLE IF NOT EXISTS drawings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drawings_symbol ON drawings(symbol_key);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_key TEXT NOT NULL,
  side TEXT NOT NULL,
  otype TEXT NOT NULL,
  qty REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  tif TEXT NOT NULL DEFAULT 'gtc',
  status TEXT NOT NULL DEFAULT 'working',
  filled_qty REAL NOT NULL DEFAULT 0,
  avg_fill REAL,
  created REAL NOT NULL,
  updated REAL
);
CREATE TABLE IF NOT EXISTS fills(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  symbol_key TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equity_points(
  ts REAL PRIMARY KEY,
  value REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS journal(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_key TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  threshold REAL NOT NULL,
  ref_price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  one_shot INTEGER NOT NULL DEFAULT 1,
  cooldown INTEGER NOT NULL DEFAULT 300,
  snooze_until REAL NOT NULL DEFAULT 0,
  last_fired REAL,
  note TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_fires(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  price REAL NOT NULL,
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS keybindings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  bindings TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS layouts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  config TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  config TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bots(
  bot_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stopped',
  manifest TEXT NOT NULL DEFAULT '{}',
  config TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL,
  updated REAL NOT NULL,
  source TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bot_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  ts REAL NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_logs_bot ON bot_logs(bot_id, ts);

"""

BarRow = tuple[str, str, int, float, float, float, float, float]


_LEGACY_BAR_RENAMES = {
    "open": "o",
    "high": "h",
    "low": "l",
    "close": "c",
    "volume": "v",
}


class Store:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._lock = threading.Lock()
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA busy_timeout=10000")
        self.conn.executescript(_SCHEMA)
        self._migrate_legacy_bars()
        self._migrate_versioned()

    # ── schema versioning ───────────────────────────────────────────────
    #
    # Until now the "migration story" was CREATE TABLE IF NOT EXISTS plus
    # hope: any column added after users already had a DB simply never
    # appeared in theirs (this is exactly why `bots.source` needs one — old
    # databases have a bots table without it, and upsert would throw
    # OperationalError at the first deploy). PRAGMA user_version is the
    # standard, dependency-free ladder. Bump SCHEMA_VERSION with each step.
    _SCHEMA_VERSION = 1

    def _migrate_versioned(self) -> None:
        cur = int(self.conn.execute("PRAGMA user_version").fetchone()[0])
        if cur == self._SCHEMA_VERSION:
            return
        if cur < 1:
            cols = [r[1] for r in self.conn.execute("PRAGMA table_info(bots)")]
            if "source" not in cols:
                self.conn.execute("ALTER TABLE bots ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        # Future migrations: elif cur < 2: ... keep every step idempotent.
        self.conn.execute(f"PRAGMA user_version = {self._SCHEMA_VERSION}")
        self.conn.commit()

    def _migrate_legacy_bars(self) -> None:
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(bars)")]
        renames = {
            old: new
            for old, new in _LEGACY_BAR_RENAMES.items()
            if old in cols and new not in cols
        }
        if not renames:
            return
        with self._lock:
            for old, new in renames.items():
                self.conn.execute(
                    f"ALTER TABLE bars RENAME COLUMN {old} TO {new}"
                )
            self.conn.commit()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def ensure_watchlist(self, name: str = "Main") -> int:
        with self._lock:
            self.conn.execute(
                "INSERT OR IGNORE INTO watchlists(name) VALUES (?)", (name,)
            )
            row = self.conn.execute(
                "SELECT id FROM watchlists WHERE name = ?", (name,)
            ).fetchone()
            # Commit even when nothing changed. Without it, every standalone
            # call (symbols() on the request path does exactly this) leaves an
            # OPEN WRITE TRANSACTION on this connection, which then blocks the
            # AsyncStore writer thread on the WAL until busy_timeout saves us.
            # That "10s timeout" in __init__ exists only because of this bug.
            self.conn.commit()
            return int(row["id"])

    def add_symbol(self, key: str, list_name: str = "Main") -> None:
        lid = self.ensure_watchlist(list_name)
        with self._lock:
            pos = self.conn.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 AS p "
                "FROM watchlist_items WHERE list_id = ?",
                (lid,),
            ).fetchone()["p"]
            self.conn.execute(
                "INSERT OR IGNORE INTO watchlist_items(list_id, symbol_key, position, added) "
                "VALUES (?, ?, ?, ?)",
                (lid, key, pos, time.time()),
            )
            self.conn.commit()

    def remove_symbol(self, key: str, list_name: str = "Main") -> bool:
        lid = self.ensure_watchlist(list_name)
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM watchlist_items WHERE list_id = ? AND symbol_key = ?",
                (lid, key),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def symbols(self, list_name: str = "Main") -> list[tuple[str, int]]:
        lid = self.ensure_watchlist(list_name)
        with self._lock:
            rows = self.conn.execute(
                "SELECT symbol_key, position FROM watchlist_items "
                "WHERE list_id = ? ORDER BY position",
                (lid,),
            ).fetchall()
        return [(r["symbol_key"], r["position"]) for r in rows]

    def upsert_bars(self, rows: Iterable[BarRow]) -> None:
        with self._lock:
            self.conn.executemany(
                "INSERT INTO bars(symbol_key, interval, ts, o, h, l, c, v) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(symbol_key, interval, ts) DO UPDATE SET "
                "o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v",
                list(rows),
            )
            self.conn.commit()

    def get_bars(
        self,
        symbol_key: str,
        interval: str,
        limit: int | None = None,
    ) -> list[dict]:
        sql = (
            "SELECT symbol_key, interval, ts, o, h, l, c, v FROM bars "
            "WHERE symbol_key = ? AND interval = ? ORDER BY ts DESC"
        )
        params: Sequence = [symbol_key, interval]
        if limit is not None:
            sql += " LIMIT ?"
            params = [symbol_key, interval, limit]
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        out = [
            {
                "ts": r["ts"],
                "o": r["o"],
                "h": r["h"],
                "l": r["l"],
                "c": r["c"],
                "v": r["v"],
            }
            for r in rows
        ]
        out.reverse()
        return out

    def last_bar_ts(self, symbol_key: str, interval: str) -> int | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(ts) AS t FROM bars WHERE symbol_key = ? AND interval = ?",
                (symbol_key, interval),
            ).fetchone()
        return row["t"] if row and row["t"] is not None else None

    def add_drawing(
        self, symbol_key: str, kind: str, payload: "str | dict"
    ) -> int:
        if not isinstance(payload, str):
            payload = json.dumps(payload)
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO drawings(symbol_key, kind, payload, created) "
                "VALUES (?, ?, ?, ?)",
                (symbol_key, kind, payload, time.time()),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def drawings(self, symbol_key: str) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, kind, payload FROM drawings "
                "WHERE symbol_key = ? ORDER BY id",
                (symbol_key,),
            ).fetchall()
        return [
            {"id": r["id"], "kind": r["kind"], "payload": json.loads(r["payload"])}
            for r in rows
        ]

    def remove_drawing(self, drawing_id: int) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM drawings WHERE id = ?", (drawing_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0

    def insert_order(self, row: dict) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO orders(symbol_key, side, otype, qty, limit_price, "
                "stop_price, tif, status, filled_qty, avg_fill, created, updated) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["symbol_key"], row["side"], row["otype"], row["qty"],
                    row.get("limit_price"), row.get("stop_price"),
                    row.get("tif", "gtc"), row.get("status", "working"),
                    row.get("filled_qty", 0), row.get("avg_fill"),
                    row.get("created", time.time()), row.get("updated"),
                ),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    # Whitelists for the dynamic UPDATE builders. Column names are inlined
    # into SQL (values are always parameterized), so an **kwargs passthrough
    # from any future request body would otherwise be a classic SQL injection
    # in the KEYS, not the values. Keep these in sync with _SCHEMA.
    _ORDER_COLS = {
        "symbol_key", "side", "otype", "qty", "limit_price", "stop_price",
        "tif", "status", "filled_qty", "avg_fill", "created", "updated",
    }
    _ALERT_COLS = {
        "symbol_key", "kind", "threshold", "ref_price", "active", "one_shot",
        "cooldown", "snooze_until", "last_fired", "note", "created",
    }

    @staticmethod
    def _safe_cols(table_cols: set[str], fields: dict) -> str:
        bad = set(fields) - table_cols
        if bad:
            raise ValueError(f"unknown columns for update: {sorted(bad)}")
        return ", ".join(f"{k} = ?" for k in fields)

    def update_order(self, order_id: int, **fields) -> None:
        if not fields:
            return
        cols = self._safe_cols(self._ORDER_COLS, fields)
        vals = list(fields.values()) + [order_id]
        with self._lock:
            self.conn.execute(
                f"UPDATE orders SET {cols} WHERE id = ?", vals
            )
            self.conn.commit()

    def get_orders(self, status: str | None = None) -> list[dict]:
        sql = "SELECT * FROM orders"
        params: Sequence
        if status:
            sql += " WHERE status = ?"
            params = [status]
        else:
            params = []
        sql += " ORDER BY id DESC LIMIT 500"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def insert_fill(self, order_id: int, symbol_key: str, side: str,
                    qty: float, price: float, fee: float, ts: float) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO fills(order_id, symbol_key, side, qty, price, fee, ts) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (order_id, symbol_key, side, qty, price, fee, ts),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def get_fills(self, limit: int = 500) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM fills ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def add_cash(self, amount: float, reason: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO cash_ledger(ts, amount, reason) VALUES (?, ?, ?)",
                (time.time(), amount, reason),
            )
            self.conn.commit()

    def cash_flows(self) -> tuple[float, list[dict]]:
        with self._lock:
            deposits = self.conn.execute(
                "SELECT COALESCE(SUM(amount), 0) AS s FROM cash_ledger"
            ).fetchone()["s"]
            fills = [
                dict(r)
                for r in self.conn.execute(
                    "SELECT * FROM fills ORDER BY id ASC"
                ).fetchall()
            ]
        return float(deposits), fills

    def add_equity_point(self, value: float) -> None:
        now = time.time()
        with self._lock:
            self.conn.execute(
                "INSERT INTO equity_points(ts, value) VALUES (?, ?) "
                "ON CONFLICT(ts) DO UPDATE SET value = excluded.value",
                (int(now // 30 * 30), value),
            )
            self.conn.commit()

    def equity_points(self, limit: int = 3000) -> list[tuple[float, float]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT ts, value FROM equity_points ORDER BY ts ASC LIMIT ?",
                (limit,),
            ).fetchall()
        return [(r["ts"], r["value"]) for r in rows]

    def add_journal(self, symbol_key: str, text: str, tags: str) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO journal(symbol_key, text, tags, created) "
                "VALUES (?, ?, ?, ?)",
                (symbol_key, text, tags, time.time()),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def journal(self, limit: int = 200) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM journal ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def remove_journal(self, entry_id: int) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM journal WHERE id = ?", (entry_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0

    def keybindings(self, name: str | None = None) -> list[dict]:
        """Get keybindings by name or all keybindings."""
        with self._lock:
            if name:
                row = self.conn.execute(
                    "SELECT id, name, bindings, created FROM keybindings WHERE name = ?",
                    (name,),
                ).fetchone()
                if row:
                    return [{"id": row["id"], "name": row["name"], "bindings": row["bindings"], "created": row["created"]}]
                return []
            rows = self.conn.execute(
                "SELECT id, name, bindings, created FROM keybindings ORDER BY created DESC"
            ).fetchall()
            return [
                {"id": r["id"], "name": r["name"], "bindings": r["bindings"], "created": r["created"]}
                for r in rows
            ]

    def add_keybinding(self, name: str, bindings: str) -> int:
        """Add new keybinding config. Returns the new ID."""
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO keybindings(name, bindings, created) VALUES (?, ?, ?)",
                (name, bindings, time.time()),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def update_keybinding(self, kb_id: int, name: str, bindings: str) -> bool:
        """Update keybinding config. (Parameter used to be named `alert_id`,
        because this whole triplet was pasted off the alerts code. It was.)"""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE keybindings SET name = ?, bindings = ? WHERE id = ?",
                (name, bindings, kb_id),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def remove_keybinding(self, kb_id: int) -> bool:
        """Remove keybinding config."""
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM keybindings WHERE id = ?", (kb_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0


    def layouts(self, name: str | None = None) -> list[dict]:
        """Get layouts by name or all layouts."""
        with self._lock:
            if name:
                row = self.conn.execute(
                    "SELECT id, name, config, created FROM layouts WHERE name = ?",
                    (name,),
                ).fetchone()
                if row:
                    return [{"id": row["id"], "name": row["name"], "config": row["config"], "created": row["created"]}]
                return []
            rows = self.conn.execute(
                "SELECT id, name, config, created FROM layouts ORDER BY created DESC"
            ).fetchall()
            return [
                {"id": r["id"], "name": r["name"], "config": r["config"], "created": r["created"]}
                for r in rows
            ]

    def add_layout(self, name: str, config: str) -> int:
        """Add new layout config. Returns the new ID."""
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO layouts(name, config, created) VALUES (?, ?, ?)",
                (name, config, time.time()),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def update_layout(self, layout_id: int, name: str, config: str) -> bool:
        """Update layout config."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE layouts SET name = ?, config = ? WHERE id = ?",
                (name, config, layout_id),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def remove_layout(self, layout_id: int) -> bool:
        """Remove layout config."""
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM layouts WHERE id = ?", (layout_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0


    def workspaces(self, name: str | None = None) -> list[dict]:
        """Get workspaces by name or all workspaces."""
        with self._lock:
            if name:
                row = self.conn.execute(
                    "SELECT id, name, config, created FROM workspaces WHERE name = ?",
                    (name,),
                ).fetchone()
                if row:
                    return [{"id": row["id"], "name": row["name"], "config": row["config"], "created": row["created"]}]
                return []
            rows = self.conn.execute(
                "SELECT id, name, config, created FROM workspaces ORDER BY created DESC"
            ).fetchall()
            return [
                {"id": r["id"], "name": r["name"], "config": r["config"], "created": r["created"]}
                for r in rows
            ]

    def add_workspace(self, name: str, config: str) -> int:
        """Add new workspace config. Returns the new ID."""
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO workspaces(name, config, created) VALUES (?, ?, ?)",
                (name, config, time.time()),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def update_workspace(self, workspace_id: int, name: str, config: str) -> bool:
        """Update workspace config."""
        with self._lock:
            cur = self.conn.execute(
                "UPDATE workspaces SET name = ?, config = ? WHERE id = ?",
                (name, config, workspace_id),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def remove_workspace(self, workspace_id: int) -> bool:
        """Remove workspace config."""
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM workspaces WHERE id = ?", (workspace_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0

    def insert_alert(self, row: dict) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO alerts(symbol_key, kind, threshold, ref_price, active, "
                "one_shot, cooldown, snooze_until, last_fired, created, note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["symbol_key"], row["kind"], row["threshold"],
                    row.get("ref_price"), int(row.get("active", True)),
                    int(row.get("one_shot", True)), int(row.get("cooldown", 300)),
                    0.0, None, time.time(), row.get("note", ""),
                ),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def alerts(self, active_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM alerts"
        if active_only:
            sql += " WHERE active = 1"
        sql += " ORDER BY id DESC LIMIT 500"
        with self._lock:
            rows = self.conn.execute(sql).fetchall()
        return [dict(r) for r in rows]

    def update_alert(self, alert_id: int, **fields) -> bool:
        if not fields:
            return False
        cols = self._safe_cols(self._ALERT_COLS, fields)
        vals = list(fields.values()) + [alert_id]
        with self._lock:
            cur = self.conn.execute(
                f"UPDATE alerts SET {cols} WHERE id = ?", vals
            )
            self.conn.commit()
            return cur.rowcount > 0

    def remove_alert(self, alert_id: int) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM alerts WHERE id = ?", (alert_id,)
            )
            self.conn.commit()
            return cur.rowcount > 0

    def record_fire(self, alert_id: int, price: float) -> int:
        now = time.time()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO alert_fires(alert_id, price, ts) VALUES (?, ?, ?)",
                (alert_id, price, now),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def alert_fires(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT f.*, a.symbol_key, a.kind, a.threshold "
                "FROM alert_fires f JOIN alerts a ON a.id = f.alert_id "
                "ORDER BY f.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── bots ───────────────────────────────────────────────────────────
    def upsert_bot(
        self,
        bot_id: str,
        name: str,
        state: str,
        manifest: str,
        config: str,
        created: float,
        updated: float,
        source: str = "",
    ) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO bots(bot_id, name, state, manifest, config, created, updated, source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(bot_id) DO UPDATE SET "
                "name=excluded.name, state=excluded.state, manifest=excluded.manifest, "
                "config=excluded.config, updated=excluded.updated, source=excluded.source",
                (bot_id, name, state, manifest, config, created, updated, source),
            )
            self.conn.commit()

    def set_bot_state(self, bot_id: str, state: str, updated: float) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE bots SET state = ?, updated = ? WHERE bot_id = ?",
                (state, updated, bot_id),
            )
            self.conn.commit()

    def delete_bot(self, bot_id: str) -> bool:
        with self._lock:
            cur = self.conn.execute("DELETE FROM bots WHERE bot_id = ?", (bot_id,))
            self.conn.execute("DELETE FROM bot_logs WHERE bot_id = ?", (bot_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def bots(self) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT * FROM bots ORDER BY created DESC").fetchall()
        return [dict(r) for r in rows]

    def add_bot_log(self, bot_id: str, ts: float, level: str, message: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO bot_logs(bot_id, ts, level, message) VALUES (?, ?, ?, ?)",
                (bot_id, ts, level, message),
            )
            # keep last 500 lines per bot
            self.conn.execute(
                "DELETE FROM bot_logs WHERE bot_id = ? AND id NOT IN "
                "(SELECT id FROM bot_logs WHERE bot_id = ? ORDER BY ts DESC LIMIT 500)",
                (bot_id, bot_id),
            )
            self.conn.commit()

    def bot_logs(self, bot_id: str, limit: int = 200) -> list[dict]:
        # ORDER BY ts ASC LIMIT n returns the OLDEST n lines — every bot log
        # view would then show the first 200 lines of a bot that deployed
        # hours ago. Grab the NEWEST window, re-sort chronologically for the
        # caller. limit is clamped by callers; keep a defensive cap here too.
        limit = max(1, min(int(limit), 1000))
        with self._lock:
            rows = self.conn.execute(
                "SELECT ts, level, message FROM ("
                "  SELECT ts, level, message FROM bot_logs WHERE bot_id = ?"
                "  ORDER BY ts DESC LIMIT ?"
                ") ORDER BY ts ASC",
                (bot_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]
