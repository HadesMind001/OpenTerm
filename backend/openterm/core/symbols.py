"""Ticker grammar: the ONE place free-text becomes an Instrument.

Resolution is deliberately ORDERED — the same six letters can be a stock, a
currency pair or a crypto quote currency, and "first match wins" only works
if the checks run in this sequence:

    aliases (APPLE) → explicit pairs (BTCUSDT) → FX (EURUSD, both ISO)
    → crypto majors (BTC → BTCUSDT) → generic equity fallback (AAPL)

Why that order: `EURUSD` also matches the equity regex (≤6 A-Z letters), so
FX must be checked first or it lands in EQUITY:EURUSD; and a raw 3-letter
major must not resolve as equity — "BTC is EQUITY:BTC on a tapi tape from
1998" is not what a terminal user means.
There is deliberately NO fuzzy matching in here: every branch must fully
match, and the equity fallback is sanity-checked against Yahoo by the
resolve route (`_verify_equity`), because the grammar cannot know whether
"ZZQT" is a real listing — only the venue can.

Suffix stripping ("TSLA US", "SAP US EQUITY"): Bloomberg-style tails. Every
token after the first must be a known suffix or the whole thing is NOT
symbol-ish (it's a multi-word phrase the command line should handle as such)
— otherwise "APPLE INC BAKERY" would happily resolve to APPLE.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

ASSET_CRYPTO = "CRYPTO"
ASSET_EQUITY = "EQUITY"
ASSET_FX = "FX"

# Curated, not scraped: the majors we auto-pair to USDT. Deliberately small —
# a wrong guess (auto-pairing some random 3-letter token to USDT) is worse
# than a missing one; unlisted coins still work via their full pair symbol
# (e.g. "WIFUSDT" resolves through _PAIR_RE).
CRYPTO_MAJORS = {
    "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT",
    "LTC", "BCH", "TRX", "NEAR", "ATOM", "XLM", "ARB", "OP", "INJ",
    "SUI", "APT", "FIL", "ETC", "UNI", "AAVE", "TON", "PEPE", "SHIB",
    "RENDER", "SEI", "TIA", "MATIC",
}

EQUITY_SUFFIXES = {"US", "EQUITY", "INC", "CORP", "PLC", "UR", "N"}

# Command-bar verbs that look like tickers. resolve() must refuse them or
# `GP` alone would add a stock called GP to the watchlist.
VERBS = {"GP", "DES", "TAPE", "BOOK", "NEWS", "HP", "PORTF", "BLT"}

# Only unambiguous, high-traffic names. "MICROSOFT" is safe; a name that
# could belong to two listings is NOT added (guessing wrong equity is worse
# than a 404 that tells the user to be explicit).
ALIASES = {
    "APPLE": ("EQUITY:AAPL"),
    "TESLA": ("EQUITY:TSLA"),
    "MICROSOFT": ("EQUITY:MSFT"),
    "AMAZON": ("EQUITY:AMZN"),
    "GOOGLE": ("EQUITY:GOOGL"),
    "ALPHABET": ("EQUITY:GOOGL"),
    "NVIDIA": ("EQUITY:NVDA"),
    "META": ("EQUITY:META"),
    "FACEBOOK": ("EQUITY:META"),
    "NETFLIX": ("EQUITY:NFLX"),
    "AMD": ("EQUITY:AMD"),
    "INTEL": ("EQUITY:INTC"),
    "COINBASE": ("EQUITY:COIN"),
    "BITCOIN": ("CRYPTO:BTCUSDT"),
    "ETHEREUM": ("CRYPTO:ETHUSDT"),
    "SOLANA": ("CRYPTO:SOLUSDT"),
    "DOGECOIN": ("CRYPTO:DOGEUSDT"),
    "RIPPLE": ("CRYPTO:XRPUSDT"),
    "CARDANO": ("CRYPTO:ADAUSDT"),
    "LITECOIN": ("CRYPTO:LTCUSDT"),
}

_PAIR_RE = re.compile(r"^[A-Z]{2,10}(USDT|USDC)$")
_TICKER_RE = re.compile(r"^[A-Z]{1,6}$")
_FX_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})$")

ISO_CCYS = {
    "USD", "EUR", "JPY", "GBP", "CHF", "AUD", "NZD", "CAD",
    "SEK", "NOK", "SGD", "HKD", "MXN", "ZAR", "TRY", "PLN", "CNY",
}


@dataclass(frozen=True)
class Instrument:
    asset_class: str
    ticker: str
    display_name: str = ""
    binance: str | None = None
    yahoo: str | None = None
    oanda: str | None = None

    @property
    def key(self) -> str:
        return f"{self.asset_class}:{self.ticker}"


def from_key(key: str) -> Instrument | None:
    if ":" not in key:
        return None
    asset, _, ticker = key.partition(":")
    asset = asset.upper()
    ticker = ticker.upper()
    if asset == ASSET_CRYPTO:
        return Instrument(asset, ticker, ticker, binance=ticker.lower())
    if asset == ASSET_EQUITY and _TICKER_RE.match(ticker):
        return Instrument(asset, ticker, ticker, yahoo=ticker)
    if asset == ASSET_FX:
        fx = _FX_RE.match(ticker)
        oanda = f"{fx.group(1)}_{fx.group(2)}" if fx else None
        return Instrument(asset, ticker, ticker, oanda=oanda)
    return None


def resolve(query: str) -> Instrument | None:
    q = (query or "").strip().upper()
    if not q or q in VERBS:
        return None
    tokens = [t for t in q.split() if t]
    if tokens and len(tokens) > 1:
        base = tokens[0]
        rest = set(tokens[1:])
        if base in VERBS or not rest <= EQUITY_SUFFIXES:
            return None
        q = base
    if q in ALIASES:
        key = ALIASES[q]
        inst = from_key(key)
        return inst
    if q in VERBS:
        return None
    # Full pairs BEFORE FX: "XUSDT"-style tails are crypto, never currencies.
    if _PAIR_RE.match(q) and len(q) > 5:
        return Instrument(ASSET_CRYPTO, q, q, binance=q.lower())
    # Both legs must be real ISO codes — "ZZZABC" is a coin, not a currency
    # pair; without this gate the equity fallback below would take any 6
    # letters that happen to also match [A-Z]{6}... which they ALL do.
    fx = _FX_RE.match(q)
    if fx and fx.group(1) in ISO_CCYS and fx.group(2) in ISO_CCYS:
        return Instrument(
            ASSET_FX, q, q, oanda=f"{fx.group(1)}_{fx.group(2)}"
        )
    # Majors before the equity catch-all: the same token ("LTC", "XLM") is a
    # valid US ticker shape and would otherwise silently become EQUITY:*.
    if q in CRYPTO_MAJORS:
        pair = f"{q}USDT"
        return Instrument(ASSET_CRYPTO, pair, pair, binance=pair.lower())
    if _TICKER_RE.match(q):
        # Equity fallback: the ONLY branch with a maybe-wrong answer, which
        # is why the route verifies it against Yahoo before accepting.
        return Instrument(ASSET_EQUITY, q, q, yahoo=q)
    return None
