from __future__ import annotations

from typing import Any

from .base import Provider, check_status

BASE = "https://api.stlouisfed.org/fred"

SERIES: dict[str, str] = {
    "CPIAUCSL": "CPI (YoY %)",
    "FEDFUNDS": "Fed Funds Rate (%)",
    "UNRATE": "Unemployment Rate (%)",
    "DGS10": "10Y Treasury Yield (%)",
    "DGS2": "2Y Treasury Yield (%)",
}


def cpi_yoy(observations: list[dict[str, str]]) -> float | None:
    """observations sorted oldest→newest with monthly cadence."""
    vals = [
        float(o["value"])
        for o in observations
        if o.get("value") not in (".", "", None)
    ]
    if len(vals) < 13:
        return None
    return round((vals[-1] / vals[-13] - 1) * 100, 2)


class FredProvider(Provider):
    name = "fred"
    capabilities = frozenset({"macro"})
    poll_interval = 3600.0

    def __init__(self, *args: Any, key: str = "", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.key = key
        self.latest: dict[str, dict[str, Any]] = {}

    async def poll(self) -> None:
        failures = 0
        for sid, label_text in SERIES.items():
            try:
                await self._fetch_series(sid, label_text)
            except Exception:
                failures += 1
        # The old code reported healthy no matter what, so a bad API key
        # produced a green FRED dot and an empty macro panel forever.
        # Status now means "at least one series refreshed".
        if failures < len(SERIES):
            self.set_status(True)
        else:
            raise RuntimeError("all FRED series failed to fetch (bad key or outage)")

    async def _fetch_series(self, sid: str, label_text: str) -> None:
        r = await self.http.get(
            f"{BASE}/series/observations",
            params={
                "series_id": sid,
                "api_key": self.key,
                "file_type": "json",
                "sort_order": "asc",
                "limit": 36,
            },
        )
        check_status(r, "fred")
        obs = r.json().get("observations") or []
        clean = [o for o in obs if o.get("value") not in (".", "", None)]
        if not clean:
            return
        value: Any
        if sid == "CPIAUCSL":
            yoy = cpi_yoy(clean)
            if yoy is None:
                return
            value = yoy
        else:
            value = float(clean[-1]["value"])
        history = [[o["date"], float(o["value"])] for o in clean[-24:]]
        self.latest[sid] = {
            "label": label_text,
            "value": value,
            "date": clean[-1]["date"],
            "history": history,
        }

    def snapshot(self) -> dict[str, dict[str, Any]]:
        return dict(self.latest)
