from __future__ import annotations

import pytest

from openterm.core.config import load_settings
from openterm.core.symbols import from_key, resolve
from openterm.providers.fred import cpi_yoy
from openterm.providers.oanda import parse_price
from openterm.providers.polygon import parse_aggs


def test_fx_pair_resolution():
    inst = resolve("EURUSD")
    assert inst is not None
    assert inst.asset_class == "FX"
    assert inst.oanda == "EUR_USD"
    back = from_key("FX:USDJPY")
    assert back is not None and back.oanda == "USD_JPY"


def test_six_letter_equities_still_resolve_as_equity():
    for ticker in ("GOOGL", "CMCSA", "LBRDK"):
        inst = resolve(ticker)
        if inst is None:
            continue
        assert inst.asset_class == "EQUITY"


def test_non_iso_6letter_is_not_fx():
    inst = resolve("QQQQQQ")
    assert inst is None or inst.asset_class != "FX"


def test_oanda_price_parsing():
    msg = {
        "type": "PRICE",
        "instrument": "EUR_USD",
        "bids": [{"price": "1.08500"}],
        "asks": [{"price": "1.08512"}],
    }
    instrument, mid = parse_price(msg)
    assert instrument == "EUR_USD"
    assert mid == pytest.approx(1.08506, abs=1e-6)
    assert parse_price({"type": "HEARTBEAT"}) is None
    assert parse_price({"type": "PRICE", "instrument": "X"}) is None


def test_polygon_aggs_parse():
    data = {
        "results": [
            {"t": 1700000000000, "o": 100, "h": 110, "l": 99, "c": 105, "v": 1234},
            {"t": 1700000060000, "o": 105, "h": 111, "l": 104, "c": 109, "v": 2222},
            {"bad": "row"},
        ]
    }
    bars = parse_aggs(data, "AAPL", "1m")
    assert len(bars) == 2
    assert bars[0].symbol_key == "EQUITY:AAPL"
    assert bars[0].ts == 1700000000
    assert bars[-1].c == 109.0


def test_cpi_yoy_transform():
    obs = [{"date": f"2025-{i % 12 + 1:02d}-01", "value": str(100 + i)} for i in range(14)]
    yoy = cpi_yoy(obs)
    assert yoy == pytest.approx((113 / 101 - 1) * 100, rel=0.01)
    assert cpi_yoy(obs[:5]) is None
    bad = [{"date": "2025-01-01", "value": "."}] * 20
    assert cpi_yoy(bad) is None


def test_settings_precedence_env_over_json(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    cfg.write_text('{"finnhub_key": "json-key", "fred_key": "json-fred"}')
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    s = load_settings(cfg)
    assert s.finnhub_key == "json-key"
    monkeypatch.setenv("FINNHUB_API_KEY", "env-key")
    s = load_settings(cfg)
    assert s.finnhub_key == "env-key"
    assert s.fred_key == "json-fred"


def test_settings_missing_file_ok(tmp_path):
    s = load_settings(tmp_path / "nope.json")
    assert s.availability() == {
        "finnhub": False, "fred": False, "oanda": False, "polygon": False,
        "alpaca": False,
    }


def test_runtime_wires_keyed_clients(tmp_path, monkeypatch):
    monkeypatch.setenv("FINNHUB_API_KEY", "k1")
    monkeypatch.setenv("FRED_API_KEY", "k2")
    monkeypatch.setenv("POLYGON_API_KEY", "k3")
    from openterm.runtime import Runtime

    rt = Runtime(db_path=tmp_path / "t.db", with_providers=True,
                 settings=load_settings())
    assert rt.finnhub is not None and rt.polygon is not None
    assert rt.fred is not None
    names = [p.name for p in rt.providers]
    assert "fred" in names
    assert rt.history.polygon is rt.polygon
