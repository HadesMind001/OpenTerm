from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Event(BaseModel):
    symbol_key: str = ""
    feed: str = ""
    ts: datetime = Field(default_factory=utcnow)


class Trade(Event):
    price: float
    size: float = 0.0
    side: Optional[str] = None  # "buy" | "sell" | None


class Quote(Event):
    bid: float
    ask: float
    bid_size: float = 0.0
    ask_size: float = 0.0


class DepthLevel(BaseModel):
    price: float
    size: float


class Depth(Event):
    bids: list[DepthLevel] = []
    asks: list[DepthLevel] = []


class Bar(Event):
    interval: str
    ts: int  # bucket start epoch seconds
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0
    closed: bool = False


class StatsSnapshot(Event):
    last: float
    open: Optional[float] = None
    prev_close: Optional[float] = None
    day_high: Optional[float] = None
    day_low: Optional[float] = None
    volume: Optional[float] = None
    change_pct: Optional[float] = None


class NewsItem(Event):
    headline: str
    url: str = ""
    source: str = ""
    summary: str = ""
    published: Optional[datetime] = None


class ProviderStatus(Event):
    name: str
    connected: bool
    detail: str = ""


class FillEvent(Event):
    order_id: int
    fill_id: int
    side: str
    qty: float
    price: float
    fee: float = 0.0


class AlertEvent(Event):
    alert_id: int
    kind: str
    price: float
    message: str = ""


class BotEventMessage(Event):
    """Bot lifecycle/log event mirrored to the browser via the WS gateway."""
    event: str
    data: dict = Field(default_factory=dict)
