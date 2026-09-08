from __future__ import annotations

_POSITIVE = {
    "beat", "beats", "surge", "surges", "soar", "soars", "rally", "rallies",
    "gain", "gains", "jump", "jumps", "climb", "climbs", "record high",
    "upgrade", "upgraded", "outperform", "bullish", "optimism", "optimistic",
    "strong", "growth", "profit", "profits", "boost", "boosts", "rise",
    "rises", "recover", "rebounds", "wins", "approval", "breakthrough",
    "expands", "dividend", "buyback", "uptrend", "higher", "tops",
}

_NEGATIVE = {
    "miss", "misses", "plunge", "plunges", "slump", "slumps", "crash",
    "crashes", "drop", "drops", "fall", "falls", "sink", "sinks", "tumble",
    "downgrade", "downgraded", "underperform", "bearish", "fear", "fears",
    "weak", "loss", "losses", "recession", "layoffs", "lawsuit", "probe",
    "fraud", "warning", "warns", "cuts", "halted", "bankruptcy", "default",
    "selloff", "downtrend", "lower", "decline", "crisis", "inflation spike",
}


def score(headline: str) -> float:
    """Lexicon sentiment in [-1, 1]; ~0 when neutral or no signal."""
    text = headline.lower()
    words = text.replace("-", " ").split()
    pos = sum(1 for w in words if w.strip(".,:;!?()\"'") in _POSITIVE)
    neg = 0
    for phrase in _NEGATIVE:
        if " " in phrase and phrase in text:
            neg += 2
    neg += sum(1 for w in words if w.strip(".,:;!?()\"'") in _NEGATIVE)
    total = pos + neg
    if total == 0:
        return 0.0
    return round((pos - neg) / total, 3)


def label(value: float) -> str:
    if value >= 0.25:
        return "bull"
    if value <= -0.25:
        return "bear"
    return "neutral"
