from openterm.core.store import Store


def test_drawing_crud():
    store = Store(":memory:")
    assert store.drawings("EQUITY:AAPL") == []
    a = store.add_drawing("EQUITY:AAPL", "hline", {"price": 100.5})
    b = store.add_drawing("EQUITY:AAPL", "trend", {"points": [1, 2]})
    rows = store.drawings("EQUITY:AAPL")
    assert [(r["id"], r["kind"]) for r in rows] == [
        (a, "hline"), (b, "trend"),
    ]
    assert rows[0]["payload"] == {"price": 100.5}
    assert store.remove_drawing(a)
    assert not store.remove_drawing(a)
    assert len(store.drawings("EQUITY:AAPL")) == 1


def test_drawings_isolated_per_symbol(tmp_path):
    store = Store(tmp_path / "t.db")
    store.add_drawing("CRYPTO:BTCUSDT", "fib", {"levels": 3})
    assert store.drawings("EQUITY:TSLA") == []
