import pytest

from openterm.services.sentiment import label, score


@pytest.mark.parametrize(
    "headline,want",
    [
        ("Apple beats earnings expectations as revenue surges", "bull"),
        ("Stocks plunge amid recession fears and layoffs", "bear"),
        ("Company announces quarterly review meeting", "neutral"),
    ],
)
def test_score_labels(headline, want):
    s = score(headline)
    assert (s >= 0.25) - (s <= -0.25) == {"bull": 1, "bear": -1, "neutral": 0}[want]
    assert label(s) == want


def test_score_bounds():
    for headline in ["", "the of and", "BEATS! beats beats"]:
        s = score(headline)
        assert -1 <= s <= 1
