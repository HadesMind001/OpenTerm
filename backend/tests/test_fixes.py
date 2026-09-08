from __future__ import annotations

import sqlite3

import pytest

from openterm.core.store import Store
from openterm.core.symbols import resolve


def test_legacy_bars_schema_migrated(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE bars(
          symbol_key TEXT NOT NULL, interval TEXT NOT NULL, ts INTEGER NOT NULL,
          open REAL, high REAL, low REAL, close REAL, volume REAL,
          PRIMARY KEY(symbol_key, interval, ts)
        );
        INSERT INTO bars VALUES ('CRYPTO:BTCUSDT', '1m', 100, 1, 2, 0.5, 1.5, 10);
        CREATE TABLE watchlists(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
        CREATE TABLE watchlist_items(
          list_id INTEGER, symbol_key TEXT, position INTEGER DEFAULT 0,
          added REAL DEFAULT 0, PRIMARY KEY(list_id, symbol_key));
        INSERT INTO watchlists(name) VALUES ('Main');
        INSERT INTO watchlist_items(list_id, symbol_key) VALUES (1, 'EQUITY:OLD');
        """
    )
    conn.commit()
    conn.close()

    store = Store(path)
    bars = store.get_bars("CRYPTO:BTCUSDT", "1m")
    assert len(bars) == 1
    assert bars[0]["o"] == 1 and bars[0]["v"] == 10
    store.upsert_bars([("CRYPTO:BTCUSDT", "1m", 160, 9, 9, 9, 9, 5)])
    assert store.get_bars("CRYPTO:BTCUSDT", "1m")[-1]["ts"] == 160


def test_alias_resolution():
    for name, key in [("APPLE", "EQUITY:AAPL"), ("TESLA US", "EQUITY:TSLA"),
                      ("BITCOIN", "CRYPTO:BTCUSDT")]:
        inst = resolve(name)
        assert inst is not None and inst.key == key
