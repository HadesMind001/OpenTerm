import pytest

from openterm.core.symbols import Instrument, from_key, resolve


@pytest.mark.parametrize(
    "query,expected",
    [
        ("btcusdt", ("CRYPTO", "BTCUSDT")),
        ("BTC", ("CRYPTO", "BTCUSDT")),
        ("ETH", ("CRYPTO", "ETHUSDT")),
        ("AAPL", ("EQUITY", "AAPL")),
        ("aapl us", ("EQUITY", "AAPL")),
        ("TSLA US EQUITY", ("EQUITY", "TSLA")),
    ],
)
def test_resolve(query, expected):
    inst = resolve(query)
    assert inst is not None
    assert (inst.asset_class, inst.ticker) == expected


@pytest.mark.parametrize("query", ["!!!", "", "TOOLONGTICKER123456", "GP"])
def test_resolve_rejects_garbage(query):
    assert resolve(query) is None


def test_instrument_key_format():
    inst = Instrument("CRYPTO", "SOLUSDT")
    assert inst.key == "CRYPTO:SOLUSDT"


def test_from_key_roundtrip():
    inst = from_key("EQUITY:AAPL")
    assert inst and inst.asset_class == "EQUITY" and inst.yahoo == "AAPL"
    assert from_key("garbage") is None
