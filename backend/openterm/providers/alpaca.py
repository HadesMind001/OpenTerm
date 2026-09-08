from __future__ import annotations

from typing import Any

import httpx

PAPER_BASE = "https://paper-api.alpaca.markets/v2"

ORDER_TYPES = {"market", "limit", "stop", "stop_limit"}
TIFS = {"gtc", "day", "ioc", "fok"}


def _num(v: float) -> str:
    """Format a float without trailing zeros (Alpaca accepts decimal strings)."""
    s = format(v, "f").rstrip("0").rstrip(".")
    return s if s and s != "-0" else "0"


def to_alpaca_symbol(symbol_key: str) -> str | None:
    """EQUITY:AAPL -> AAPL; other asset classes are not tradable on Alpaca."""
    asset, _, ticker = symbol_key.partition(":")
    ticker = ticker.upper()
    if asset.upper() == "EQUITY" and ticker and "." not in ticker:
        return ticker
    return None


def order_payload(
    symbol_key: str,
    side: str,
    otype: str,
    qty: float,
    limit_price: float | None = None,
    stop_price: float | None = None,
    tif: str = "gtc",
) -> dict[str, Any]:
    """Build an Alpaca v2 order body from OpenTerm's order vocabulary."""
    symbol = to_alpaca_symbol(symbol_key)
    if symbol is None:
        raise ValueError("Alpaca trades US equities only")
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy|sell")
    if otype not in ORDER_TYPES:
        raise ValueError("unknown order type")
    # Unknown tif degrades to gtc instead of erroring: the paper engine
    # stores whatever string the ticket sent, so a stray "opg" (or a typo
    # from an old saved order) should not nuke a real-money submit request —
    # worst case the order lives longer than intended, which beats a 400.
    if tif not in TIFS:
        tif = "gtc"
    body: dict[str, Any] = {
        "symbol": symbol,
        "qty": _num(qty),
        "side": side,
        "type": otype,
        "time_in_force": tif,
    }
    if otype in ("limit", "stop_limit"):
        if not limit_price:
            raise ValueError("limit price required")
        body["limit_price"] = _num(limit_price)
    if otype in ("stop", "stop_limit"):
        if not stop_price:
            raise ValueError("stop price required")
        body["stop_price"] = _num(stop_price)
    return body


def portfolio_from(account: dict[str, Any], positions: list[dict[str, Any]]) -> dict[str, Any]:
    """Map Alpaca account+positions onto OpenTerm's Portfolio shape."""
    out_positions = []
    for p in positions:
        sym = p.get("symbol", "")
        try:
            qty = float(p.get("qty") or 0)
            avg = float(p.get("avg_entry_price") or 0)
            mark = float(p.get("current_price") or 0) or None
            upnl = float(p.get("unrealized_pl") or 0)
        except (TypeError, ValueError):
            continue
        out_positions.append({
            "symbol_key": f"EQUITY:{sym}",
            "qty": qty,
            "avg_cost": avg,
            "mark": mark,
            "value": round(qty * mark, 2) if mark else None,
            "unrealized": round(upnl, 2),
            "unrealized_pct": (
                round((mark / avg - 1) * 100, 3) if mark and avg else None
            ),
            "realized": 0.0,
        })
    try:
        cash = float(account.get("cash") or 0)
        equity = float(account.get("equity") or cash)
    except (TypeError, ValueError):
        cash, equity = 0.0, 0.0
    return {
        "cash": round(cash, 2),
        "equity": round(equity, 2),
        "unrealized": round(sum(p["unrealized"] or 0 for p in out_positions), 2),
        "positions": out_positions,
    }


def normalize_order(row: dict[str, Any]) -> dict[str, Any]:
    """Alpaca order -> OpenTerm blotter row shape."""
    leg = row.get("leg") or []
    filled = float(row.get("filled_qty") or 0)
    avg = row.get("filled_avg_price")
    try:
        created_ts = _iso_to_epoch(row.get("created_at"))
    except Exception:  # noqa: BLE001
        created_ts = None
    status_map = {"new": "working", "accepted": "working", "pending_new": "working",
                  "partially_filled": "working", "filled": "filled",
                  "canceled": "canceled", "expired": "canceled",
                  "rejected": "canceled"}
    return {
        "id": row.get("id", ""),
        "symbol_key": f"EQUITY:{row.get('symbol', '')}",
        "side": row.get("side", "buy"),
        "otype": row.get("type", "market"),
        "qty": float(row.get("qty") or 0),
        "limit_price": _f(row.get("limit_price")),
        "stop_price": _f(row.get("stop_price")),
        "tif": row.get("time_in_force", "gtc"),
        "status": status_map.get(row.get("status", ""), "working"),
        "filled_qty": filled,
        "avg_fill": float(avg) if avg else None,
        "created": created_ts,
        "updated": created_ts,
        "legs": len(leg),
    }


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _iso_to_epoch(ts: str | None) -> float | None:
    if not ts:
        return None
    from datetime import datetime, timezone

    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


class AlpacaError(RuntimeError):
    pass


class AlpacaClient:
    """Minimal Alpaca paper-trading REST client (v2)."""

    name = "alpaca"

    def __init__(self, key_id: str, secret_key: str, http: httpx.AsyncClient,
                 base: str = PAPER_BASE) -> None:
        self.key_id = key_id
        self.secret_key = secret_key
        self.http = http
        self.base = base.rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.key_id,
            "APCA-API-SECRET-KEY": self.secret_key,
        }

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        r = await self.http.request(
            method, f"{self.base}{path}", headers=self._headers(), **kw
        )
        if r.status_code >= 400:
            raise AlpacaError(f"HTTP {r.status_code} — {r.text[:200]}")
        if r.status_code == 204 or not r.content:
            return {}
        return r.json()

    async def account(self) -> dict[str, Any]:
        return await self._request("GET", "/account")

    async def positions(self) -> list[dict[str, Any]]:
        out = await self._request("GET", "/positions")
        return out if isinstance(out, list) else []

    async def portfolio(self) -> dict[str, Any]:
        account, positions = await self.account(), await self.positions()
        return portfolio_from(account, positions)

    async def orders(self, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": min(limit, 500)}
        if status:
            params["status"] = status
        out = await self._request("GET", "/orders", params=params)
        rows = out if isinstance(out, list) else []
        return [normalize_order(r) for r in rows]

    async def submit_order(self, body: dict[str, Any]) -> dict[str, Any]:
        row = await self._request("POST", "/orders", json=body)
        return normalize_order(row)

    async def cancel_order(self, order_id: str) -> bool:
        r = await self.http.request(
            "DELETE", f"{self.base}/orders/{order_id}", headers=self._headers()
        )
        if r.status_code in (200, 204):
            return True
        if r.status_code == 422:
            # WART: Alpaca answers "order does not exist (anymore)" with 422,
            # the same code it uses for genuinely invalid payloads. We
            # conflate both into "nothing canceled" — losing the difference
            # between *stale id* and *bug in our request*. Until Alpaca gives
            # 422 a machine-readable reason sub-code, False is the honest
            # maximum here; do not "fix" this into a True for non-exists.
            return False
        raise AlpacaError(f"HTTP {r.status_code} — {r.text[:200]}")

    async def verify(self) -> dict[str, Any]:
        """Cheap credential check used by /settings/test."""
        acct = await self.account()
        return {
            "ok": True,
            "provider": "alpaca",
            "account_number": acct.get("account_number", ""),
            "status": acct.get("status", ""),
        }
