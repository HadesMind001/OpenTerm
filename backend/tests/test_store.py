from openterm.core.store import Store


def test_watchlist_roundtrip(tmp_path):
    store = Store(tmp_path / "t.db")
    store.add_symbol("CRYPTO:BTCUSDT")
    store.add_symbol("EQUITY:AAPL")
    keys = [k for k, _ in store.symbols("Main")]
    assert keys == ["CRYPTO:BTCUSDT", "EQUITY:AAPL"]
    assert store.remove_symbol("EQUITY:AAPL")
    assert [k for k, _ in store.symbols("Main")] == ["CRYPTO:BTCUSDT"]
    assert not store.remove_symbol("NOPE:NOPE")


def test_bars_upsert_and_ordering(tmp_path):
    store = Store(":memory:")
    rows = [
        ("CRYPTO:BTCUSDT", "1m", 100, 1, 2, 0.5, 1.5, 10),
        ("CRYPTO:BTCUSDT", "1m", 160, 1.5, 2.5, 1, 2, 5),
        ("CRYPTO:BTCUSDT", "1m", 220, 2, 3, 1.9, 2.8, 7),
    ]
    store.upsert_bars(rows)
    bars = store.get_bars("CRYPTO:BTCUSDT", "1m")
    assert [b["ts"] for b in bars] == [100, 160, 220]
    store.upsert_bars([("CRYPTO:BTCUSDT", "1m", 160, 9, 9, 9, 9, 9)])
    bars = store.get_bars("CRYPTO:BTCUSDT", "1m")
    assert next(b for b in bars if b["ts"] == 160)["c"] == 9
    assert store.last_bar_ts("CRYPTO:BTCUSDT", "1m") == 220
    limited = store.get_bars("CRYPTO:BTCUSDT", "1m", limit=2)
    assert [b["ts"] for b in limited] == [160, 220]
