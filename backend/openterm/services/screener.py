from __future__ import annotations

from typing import Sequence

# Static curated universe, on purpose. Runtime.start() watches these under the
# "screen" tag, and Yahoo's poll is ONE chart request per equity per 10s —
# growing this list grows the request rate against a free unofficial API with
# no documented limits and a very documented temper. A dynamic "top N by
# volume" would be nicer and would get us silently banned; the 21 names here
# are liquid, recognizable, and affordable in quota terms.
DEFAULT_UNIVERSE = [
    "CRYPTO:BTCUSDT",
    "CRYPTO:ETHUSDT",
    "CRYPTO:SOLUSDT",
    "CRYPTO:XRPUSDT",
    "CRYPTO:ADAUSDT",
    "CRYPTO:DOGEUSDT",
    "CRYPTO:AVAXUSDT",
    "CRYPTO:LINKUSDT",
    "EQUITY:AAPL",
    "EQUITY:MSFT",
    "EQUITY:NVDA",
    "EQUITY:AMZN",
    "EQUITY:GOOGL",
    "EQUITY:META",
    "EQUITY:TSLA",
    "EQUITY:AMD",
    "EQUITY:SPY",
    "EQUITY:QQQ",
    "EQUITY:DIA",
    "EQUITY:GLD",
    "EQUITY:TLT",
]

# Ceiling for the REST correlation endpoints: the matrix is n² pairwise
# Pearson passes over up to 250 points each, computed synchronously in the
# request path. Ten symbols is a readable heatmap; a hundred is a stalled
# event loop and an unreadable hairball.
MAX_CORR_SYMBOLS = 10


def pearson(x: Sequence[float], y: Sequence[float]) -> float:
    """Plain Pearson r on whatever series it's handed (callers pass simple
    returns — correlating raw prices produces spurious 0.99s for anything
    with a shared trend, see _returns_matrix in routes.py).

    No population/sample covariance fuss here, and none is needed: r divides
    covariance by the product of the standard deviations, so the /n (or
    /(n-1)) factor appears in numerator and denominator and cancels. Using
    one consistently is all the math requires.

    Zero-variance series (halted stock, dead weekend, flat line) leave the
    denominator at 0 and r undefined: we return 0.0 rather than raise or
    emit NaN, because a NaN inside the JSON matrix silently breaks the
    frontend heatmap. 0.0 reads as "no relationship", which is the most
    honest thing a flat line can be correlated to.
    """
    n = min(len(x), len(y))
    if n < 2:
        return 0.0
    # Tail-truncate to the common length: keeps the MOST RECENT n points of
    # each series. Alignment is by index, not by timestamp — if one symbol
    # has gaps, its k-th return is a different day than its pair's. With
    # equal-length daily bars from the same store this can't bite in
    # practice; if you ever feed it raw provider data, timestamp-align first.
    x, y = list(x)[-n:], list(y)[-n:]
    mx = sum(x) / n
    my = sum(y) / n
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    dx = sum((a - mx) ** 2 for a in x) ** 0.5
    dy = sum((b - my) ** 2 for b in y) ** 0.5
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


def correlation_matrix(
    series: dict[str, list[float]],
) -> tuple[list[str], list[list[float]]]:
    """Align return series to a common length and produce a Pearson matrix."""
    # Series with <2 points are DROPPED entirely, not zero-filled — so the
    # returned key list may be shorter than the caller's input and the
    # frontend must label the matrix with THESE keys, never with the list it
    # requested.
    keys = sorted(k for k in series if len(series[k]) >= 2)
    if not keys:
        return [], []
    # Same tail-truncation rationale as pearson(): keep the freshest n
    # observations across the whole panel, at the cost of shrinking every
    # longer series to the shortest one's window.
    n = min(len(series[k]) for k in keys)
    data = {k: series[k][-n:] for k in keys}
    size = len(keys)
    mat = [[1.0] * size for _ in range(size)]
    for i, a in enumerate(keys):
        for j in range(i + 1, size):
            b = keys[j]
            r = round(pearson(data[a], data[b]), 3)
            mat[i][j] = r
            mat[j][i] = r
    return keys, mat
