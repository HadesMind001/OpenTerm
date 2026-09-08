"""Store regressions: bot log window direction, SQL column whitelist,
user_version migration v1 (bots.source)."""
from __future__ import annotations

import sqlite3

import pytest

from openterm.core.store import Store


def test_bot_logs_return_the_newest_window(tmp_path):
    store = Store(tmp_path / "l.db")
    for i in range(10):
        store.add_bot_log("b1", float(1000 + i), "info", f"line-{i}")
    rows = store.bot_logs("b1", limit=3)
    assert [r["message"] for r in rows] == ["line-7", "line-8", "line-9"], (
        "got the OLDEST lines — the ASC/LIMIT direction bug is back"
    )
    assert store.bot_logs("b1", limit=0) or store.bot_logs("b1", limit=1)
    # other bots' noise never shows up
    store.add_bot_log("b2", 1001.0, "info", "not-for-b1")
    assert all("not-for-b1" not in r["message"] for r in store.bot_logs("b1"))


def test_update_order_rejects_unknown_columns(tmp_path):
    store = Store(tmp_path / "o.db")
    oid = store.insert_order({
        "symbol_key": "CRYPTO:BTCUSDT", "side": "buy", "otype": "limit",
        "qty": 1.0, "limit_price": 5.0, "stop_price": None, "tif": "gtc",
        "status": "working", "filled_qty": 0.0, "avg_fill": None,
        "created": 1.0,
    })
    store.update_order(oid, status="canceled")  # legit column: fine
    with pytest.raises(ValueError):
        store.update_order(oid, **{"status = 'filled', --": "x"})
    with pytest.raises(ValueError):
        store.update_order(oid, nonexistent_col=1)
    row = next(r for r in store.get_orders() if r["id"] == oid)
    assert row["status"] == "canceled"


def test_migration_v1_adds_bots_source_to_legacy_db(tmp_path):
    """Old shipped DBs have a bots table WITHOUT `source`; upsert_bot would
    OperationalError on them. user_version-migration must patch it in."""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE bots(
          bot_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT,
          manifest TEXT, config TEXT, created REAL, updated REAL
        );
        INSERT INTO bots VALUES ('b-legacy', 'old', 'stopped', '', '{}', 1, 1);
        """
    )
    conn.commit()
    conn.close()

    store = Store(path)
    cols = [r[1] for r in store.conn.execute("PRAGMA table_info(bots)")]
    assert "source" in cols, "migration v1 did not add bots.source"
    assert store.conn.execute("PRAGMA user_version").fetchone()[0] == 1

    # round-trip on the patched legacy table
    store.upsert_bot("b-legacy", "old", "stopped", "", "{}", 1, 2, source="x=1")
    row = next(b for b in store.bots() if b["bot_id"] == "b-legacy")
    assert row["source"] == "x=1"
    # idempotent: reopening must not crash or double-add
    again = Store(path)
    cols2 = [r[1] for r in again.conn.execute("PRAGMA table_info(bots)")]
    assert cols2.count("source") == 1
    again.close()


def test_ensure_watchlist_commits(tmp_path):
    """ensure_watchlist used to leave an OPEN write transaction on the
    connection when the row already existed — which then blocked the
    AsyncStore writer thread against the WAL."""
    path = tmp_path / "w.db"
    store = Store(path)
    store.ensure_watchlist("Main")
    # A second, separate connection must not be blocked by a dangling txn:
    conn2 = sqlite3.connect(path, timeout=0.25)
    conn2.execute("BEGIN IMMEDIATE")  # fails instantly if store left txn open
    conn2.execute("SELECT 1")
    conn2.rollback()
    conn2.close()
