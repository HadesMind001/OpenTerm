"""All REST API routes for OpenTerm.

Layout of this file (it is big — 70+ endpoints):
  helpers          → symbol verification, Yahoo chart fetch
  market data      → /health /symbols /bars /snapshot /news /universe
  drawings         → chart drawings CRUD
  watchlist        → watchlist CRUD
  settings/keys    → provider keys (see SECURITY NOTES in keys_test — read before touching)
  alerts           → alert rules + fires
  DES              → per-symbol detail endpoint
  trading          → paper orders / fills / portfolio / cash / Alpaca passthrough
  journal          → notes
  prefs CRUD       → keybindings / layouts / workspaces (single factory, see _crud_triplet)
  analytics        → correlation (both flavors share one code path now)
  options          → Black-Scholes greeks + chains (options_router)
  scripts          → local subprocess Python execution (NOT a sandbox — see services/scripting.py)
  bots             → router included from api/bots.py (EXPERIMENTAL, does not execute anything)
"""
from __future__ import annotations

import json
import re
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..core.symbols import ASSET_EQUITY, from_key, resolve
from ..providers.finnhub import FinnhubClient
from ..providers.polygon import PolygonClient
from ..services.screener import MAX_CORR_SYMBOLS, correlation_matrix
from ..services.scripting import ScriptRunResult, ScriptingService
from ..services.options import OptionsService, compute_greeks
from ..services.sentiment import label as sentiment_label
from ..services.sentiment import score as sentiment_score
from ..api.bots import router as bots_router

log = logging.getLogger("openterm.api")

api_router = APIRouter()

_verify_cache: dict[str, tuple[bool, float]] = {}
_VERIFY_OK_TTL = 3600.0
_VERIFY_BAD_TTL = 86400.0
# Symbols that genuinely 404 on Yahoo get remembered as dead for a day.
# Anything else (429, 5xx, timeout) is Yahoo rate-limiting *us* — caching that
# as "unknown symbol" would blacklist perfectly good tickers for 24h after one
# bad evening, so transient failures now surface as 503 and are NOT cached.
_TRANSIENT_STATUSES = {429, 403, 500, 502, 503, 504}

_YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"


async def _yahoo_chart(rt, ticker: str, interval: str, rng: str) -> dict[str, Any] | None:
    """One shared Yahoo chart fetch. Returns the first `chart.result` entry, or None.

    Every previous copy-paste of this call in this file had slightly different
    error handling, which is how the verify/des/greeks endpoints each developed
    their own bugs. This one raises on transient upstream failures so callers
    can distinguish "Yahoo says no" from "Yahoo is throttling us".
    """
    resp = await rt.http.get(
        _YAHOO_CHART + ticker,
        params={"interval": interval, "range": rng},
    )
    if resp.status_code in _TRANSIENT_STATUSES:
        raise HTTPException(
            status_code=503,
            detail=f"market data provider busy (HTTP {resp.status_code}) — retry shortly",
        )
    if resp.status_code != 200:
        return None
    result = (resp.json().get("chart") or {}).get("result")
    return result[0] if result else None


async def _verify_equity(request: Request, inst) -> None:
    if inst.asset_class != ASSET_EQUITY or not inst.yahoo:
        return
    rt = request.app.state.runtime
    if not getattr(rt, "with_providers", True):
        return
    now = time.monotonic()
    hit = _verify_cache.get(inst.ticker)
    if hit:
        ok, until = hit
        if now < until:
            if not ok:
                raise HTTPException(
                    status_code=404,
                    detail=f"unknown symbol '{inst.ticker}'",
                )
            return
    try:
        entry = await _yahoo_chart(rt, inst.yahoo, "1d", "1d")
        ok = entry is not None
    except HTTPException:
        # Transient (or our own 503): do NOT poison the cache, do not call the
        # symbol unknown — the client can retry.
        raise
    _verify_cache[inst.ticker] = (ok, now + (_VERIFY_OK_TTL if ok else _VERIFY_BAD_TTL))
    if not ok:
        raise HTTPException(
            status_code=404, detail=f"unknown symbol '{inst.ticker}'"
        )


@api_router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    rt = request.app.state.runtime
    return {
        "ok": True,
        "time": datetime.now(timezone.utc).isoformat(),
        "statuses": rt.statuses(),
        "watched": sorted(rt._watched.keys()),
    }


@api_router.get("/symbols/resolve")
async def symbols_resolve(request: Request, q: str) -> dict[str, Any]:
    inst = resolve(q)
    if inst is None:
        raise HTTPException(status_code=404, detail="unknown symbol")
    await _verify_equity(request, inst)
    return {
        "symbol_key": inst.key,
        "asset_class": inst.asset_class,
        "ticker": inst.ticker,
        "display_name": inst.display_name,
    }


class WatchlistAdd(BaseModel):
    query: str


class DrawingAdd(BaseModel):
    symbol_key: str
    kind: str
    payload: dict[str, Any]


@api_router.get("/drawings")
async def drawings_get(request: Request, symbol_key: str) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    return rt.store.drawings(symbol_key)


@api_router.post("/drawings")
async def drawings_post(request: Request, body: DrawingAdd) -> dict[str, Any]:
    rt = request.app.state.runtime
    did = rt.store.add_drawing(body.symbol_key, body.kind,
                               json.dumps(body.payload))
    return {"id": did}


@api_router.delete("/drawings/{drawing_id}")
async def drawings_delete(request: Request, drawing_id: int) -> dict[str, bool]:
    rt = request.app.state.runtime
    return {"removed": rt.store.remove_drawing(drawing_id)}


@api_router.get("/watchlist")
async def watchlist_get(request: Request) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    out = []
    for key, position in rt.store.symbols("Main"):
        inst = from_key(key)
        state = rt.market_state.get(key) or {}
        out.append({
            "symbol_key": key,
            "position": position,
            "asset_class": inst.asset_class if inst else "?",
            "ticker": inst.ticker if inst else key.split(":")[-1],
            "state": state,
        })
    return out


@api_router.post("/watchlist")
async def watchlist_add(request: Request, body: WatchlistAdd) -> dict[str, Any]:
    rt = request.app.state.runtime
    inst = resolve(body.query)
    if inst is None:
        raise HTTPException(status_code=404, detail="unknown symbol")
    await _verify_equity(request, inst)
    rt.store.add_symbol(inst.key, "Main")
    rt.watch([inst.key], "watchlist")
    return {"symbol_key": inst.key, "ticker": inst.ticker,
            "asset_class": inst.asset_class}


@api_router.delete("/watchlist/{symbol_key:path}")
async def watchlist_remove(request: Request, symbol_key: str) -> dict[str, bool]:
    rt = request.app.state.runtime
    removed = rt.store.remove_symbol(symbol_key, "Main")
    rt.unwatch([symbol_key], "watchlist")
    return {"removed": removed}


@api_router.get("/bars/{symbol_key:path}")
async def bars_get(
    request: Request,
    symbol_key: str,
    interval: str = "1m",
    limit: int = 400,
) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    if from_key(symbol_key) is None:
        raise HTTPException(status_code=404, detail="bad symbol key")
    limit = max(10, min(limit, 1000))
    return await rt.history.bars(symbol_key, interval, limit)


@api_router.get("/snapshot")
async def snapshot(request: Request) -> dict[str, Any]:
    rt = request.app.state.runtime
    ms = rt.market_state.snapshot()
    return {
        "market": {k: v for k, v in ms.items() if v.get("last") is not None},
        "statuses": rt.statuses(),
    }


@api_router.get("/news")
async def news_get(
    request: Request,
    symbol_key: str | None = None,
    q: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    bucket = rt.news.get(symbol_key or "MARKET")
    limit = max(1, min(limit, 200))
    items = sorted(bucket or [], key=lambda n: n.ts, reverse=True)
    out = []
    # Filter FIRST, slice after — the old order silently returned fewer than
    # `limit` results whenever a `q` filter dropped items from the head.
    for n in items:
        if q and q.lower() not in n.headline.lower():
            continue
        row = n.model_dump(mode="json")
        s = sentiment_score(n.headline)
        row["sentiment"] = s
        row["sentiment_label"] = sentiment_label(s)
        out.append(row)
        if len(out) >= limit:
            break
    return out


@api_router.get("/settings")
async def settings_get(request: Request) -> dict[str, Any]:
    rt = request.app.state.runtime
    from ..core.config import config_path

    return {
        "available": rt.settings.availability(),
        "config_path": str(config_path()),
        "note": "keys are stored locally (chmod 600) and applied live — no restart needed",
    }


class KeysUpdate(BaseModel):
    finnhub_key: str | None = None
    fred_key: str | None = None
    polygon_key: str | None = None
    oanda_token: str | None = None
    oanda_account: str | None = None
    alpaca_key_id: str | None = None
    alpaca_secret_key: str | None = None


@api_router.post("/settings/keys")
async def keys_save(request: Request, body: KeysUpdate) -> dict[str, Any]:
    from ..core.config import config_path, load_settings

    rt = request.app.state.runtime
    path = config_path()
    data: dict[str, str] = {}
    try:
        data = json.loads(path.read_text())
    except Exception:
        # First run / hand-corrupted file: start from a clean slate rather
        # than failing the save. Env vars still take precedence at load time.
        log.warning("config at %s unreadable, overwriting", path, exc_info=True)
    changed = []
    for field, val in body.model_dump().items():
        if val is None:
            continue
        if val == "":
            data.pop(field, None)
        else:
            data[field] = val.strip()
        changed.append(field)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write via a private temp file with 0600 set AT CREATION, then rename.
    # Old code did write_text() (0644 under the default umask!) then chmod'd
    # after — a window where the file holding live API keys was world-readable,
    # and a crash mid-write left a half-written config behind. os.replace is
    # atomic on the same filesystem.
    tmp = path.parent / (path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(data, indent=2))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        path.chmod(0o600)  # belt & braces in case the file already existed
    except OSError:
        pass
    fresh = load_settings()
    await rt.apply_settings(fresh)
    # Never echo key material back — field names and availability bools only.
    return {"saved": changed, "available": fresh.availability()}


class TestKeyIn(BaseModel):
    provider: str
    key: str = ""
    oanda_account: str = ""
    secret: str = ""


# OANDA account ids are documented as "10 alphanumeric characters (may start with T:)".
# Anything else gets rejected locally instead of being interpolated into a URL path —
# an unvalidated `{account}` path segment lets a caller walk OANDA's API surface
# (e.g. account_id = "../<other-endpoint>") using OUR bearer token. Not our problem
# in prod (there is no prod), but the local trust model still shouldn't rope in
# third-party APIs as collateral damage.
_OANDA_ACCOUNT_RE = re.compile(r"^(?:T:)?[A-Z0-9]{8,12}$")


def _safe_error(exc: Exception) -> str:
    """Turn an exception into a client-safe error string.

    NEVER inline str(exc) for provider calls into an HTTP response: httpx's
    HTTPStatusError message contains the FULL request URL, and the finnhub/FRED/
    Polygon providers pass the API key as a query parameter. The old code did
    exactly that and handed the user's live key to any local process that could
    hit /api/settings/test (a plain CSRF-style form POST can read nothing back,
    but the same-origin app JS — or any local user — can). Redact URL-looking
    text and keep the useful signal only.
    """
    import httpx

    if isinstance(exc, httpx.HTTPStatusError):
        return f"provider rejected the request (HTTP {exc.response.status_code}) — key invalid or lacking access"
    if isinstance(exc, httpx.TimeoutException):
        return "provider timed out — check connectivity"
    if isinstance(exc, httpx.RequestError):
        return "could not reach provider"
    return f"{type(exc).__name__}: provider call failed"


@api_router.post("/settings/test")
async def keys_test(request: Request, body: TestKeyIn) -> dict[str, Any]:
    """Validate a provider API key with a minimal, cheap request.

    IMPORTANT: when a `key` is supplied we must build a THROWAWAY client with
    that key. The previous implementation did `rt.finnhub or FinnhubClient(key)`
    — i.e. whenever the provider was already configured, the *typed-in* key was
    silently ignored and the *stored* key got tested instead, so "test" showed
    green for a brand-new key that was never actually used.
    """
    rt = request.app.state.runtime
    provider = body.provider.lower()
    try:
        if provider == "finnhub":
            key = body.key or rt.settings.finnhub_key
            if not key:
                return {"ok": False, "error": "no finnhub key set"}
            await FinnhubClient(key, rt.http).profile("AAPL")
            return {"ok": True, "provider": "finnhub"}
        if provider == "polygon":
            key = body.key or rt.settings.polygon_key
            if not key:
                return {"ok": False, "error": "no polygon key set"}
            await PolygonClient(key, rt.http).backfill("AAPL", "1d", 5)
            return {"ok": True, "provider": "polygon"}
        if provider == "fred":
            key = body.key or rt.settings.fred_key
            if not key:
                return {"ok": False, "error": "no fred key set"}
            r = await rt.http.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={
                    "series_id": "FEDFUNDS",
                    "api_key": key,
                    "file_type": "json",
                    "sort_order": "desc",
                    "limit": 1,
                },
            )
            if r.status_code != 200:
                return {"ok": False, "error": f"HTTP {r.status_code} — invalid key?"}
            return {"ok": True, "provider": "fred"}
        if provider == "oanda":
            token = body.key or rt.settings.oanda_token
            account = (body.oanda_account or rt.settings.oanda_account).strip()
            if not token or not account:
                return {"ok": False, "error": "token and account id required"}
            if not _OANDA_ACCOUNT_RE.match(account):
                return {"ok": False, "error": "account id looks malformed"}
            hdrs = {"Authorization": f"Bearer {token}"}
            r = await rt.http.get(
                f"https://api-fxpractice.oanda.com/v3/accounts/{account}/summary",
                headers=hdrs,
            )
            if r.status_code != 200:
                return {"ok": False, "error": f"HTTP {r.status_code} — invalid token/account?"}
            return {"ok": True, "provider": "oanda"}
        if provider == "alpaca":
            from ..providers.alpaca import AlpacaClient

            key_id = body.key or rt.settings.alpaca_key_id
            secret = body.secret or rt.settings.alpaca_secret_key
            if not key_id or not secret:
                return {"ok": False, "error": "key id and secret required"}
            # Alpaca sends keys as headers, not URL params, and verify() normalizes
            # its own errors — no raw exception text reaches the client either way.
            return await AlpacaClient(key_id, secret, rt.http).verify()
        return {"ok": False, "error": f"unknown provider '{provider}'"}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("provider key test failed for %s", provider, exc_info=True)
        # Detailed traceback goes to the server log (where it may contain the
        # key URL); the client only ever sees the sanitized one-liner above.
        return {"ok": False, "error": _safe_error(exc)}


@api_router.get("/calendar")
async def calendar_get(request: Request, days: int = 14) -> dict[str, Any]:
    rt = request.app.state.runtime
    if rt.finnhub is None:
        return {"available": False, "earnings": []}
    try:
        rows = await rt.finnhub.earnings(min(max(days, 1), 30))
    except Exception:
        return {"available": True, "earnings": [], "error": "fetch failed"}
    return {"available": True, "earnings": rows[:80]}


@api_router.get("/macro")
async def macro_get(request: Request) -> dict[str, Any]:
    rt = request.app.state.runtime
    if rt.fred is None:
        return {"available": False, "series": {}}
    return {"available": True, "series": rt.fred.snapshot()}


class AlertCreate(BaseModel):
    symbol_key: str
    kind: str
    threshold: float
    one_shot: bool = True
    cooldown: int = 300
    note: str = ""


class AlertSnooze(BaseModel):
    seconds: int = Field(ge=1, le=86_400)


class AlertToggle(BaseModel):
    active: bool


@api_router.get("/alerts")
async def alerts_get(request: Request) -> list[dict[str, Any]]:
    return request.app.state.runtime.alerts.all_rules()


@api_router.post("/alerts")
async def alerts_create(request: Request, body: AlertCreate) -> dict[str, Any]:
    rt = request.app.state.runtime
    if from_key(body.symbol_key) is None:
        raise HTTPException(status_code=404, detail="bad symbol key")
    ref = None
    if body.kind in ("pct_up", "pct_dn"):
        ref = (rt.market_state.get(body.symbol_key) or {}).get("last")
        if not ref:
            raise HTTPException(
                status_code=400, detail="no price yet for % move baseline"
            )
    try:
        return rt.alerts.create(
            body.symbol_key,
            body.kind,
            body.threshold,
            ref_price=ref,
            one_shot=body.one_shot,
            cooldown=body.cooldown,
            note=body.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@api_router.delete("/alerts/{alert_id}")
async def alerts_delete(request: Request, alert_id: int) -> dict[str, bool]:
    return {"removed": request.app.state.runtime.alerts.remove(alert_id)}


@api_router.post("/alerts/{alert_id}/snooze")
async def alerts_snooze(
    request: Request, alert_id: int, body: AlertSnooze
) -> dict[str, bool]:
    ok = request.app.state.runtime.alerts.snooze(alert_id, body.seconds)
    if not ok:
        raise HTTPException(status_code=404, detail="no such active alert")
    return {"snoozed": True}


@api_router.post("/alerts/{alert_id}/toggle")
async def alerts_toggle(
    request: Request, alert_id: int, body: AlertToggle
) -> dict[str, bool]:
    ok = request.app.state.runtime.alerts.toggle(alert_id, body.active)
    if not ok:
        raise HTTPException(status_code=404, detail="no such alert")
    return {"toggled": True}


@api_router.get("/alerts/fires")
async def alert_fires(request: Request, limit: int = 100) -> list[dict[str, Any]]:
    # max(1, …) before min(): a bare min(limit, 300) with limit=-1 passes a
    # NEGATIVE LIMIT to SQLite, which there means "no limit" — the exact
    # opposite of clamping.
    limit = max(1, min(limit, 300))
    return request.app.state.runtime.store.alert_fires(limit)


@api_router.get("/des/{symbol_key:path}")
async def des_get(request: Request, symbol_key: str) -> dict[str, Any]:
    rt = request.app.state.runtime
    inst = from_key(symbol_key)
    if inst is None:
        raise HTTPException(status_code=404, detail="bad symbol key")
    state = rt.market_state.get(symbol_key) or {}
    extra: dict[str, Any] = {}
    peers = sorted({
        i.ticker
        for k, (i, _) in rt._watched.items()
        if i.asset_class == inst.asset_class and k != symbol_key
    })
    if inst.asset_class == ASSET_EQUITY and inst.yahoo:
        if rt.finnhub is not None:
            try:
                profile = await rt.finnhub.profile(inst.ticker)
                metrics = await rt.finnhub.metrics(inst.ticker)
                if profile:
                    extra["finnhub_profile"] = {
                        k: profile.get(k)
                        for k in ("name", "country", "industry", "ipo",
                                  "marketCapitalization", "shareOutstanding")
                        if profile.get(k)
                    }
                if metrics:
                    extra["fundamentals"] = metrics
            except Exception:
                # Finnhub profile/metrics are best-effort enrichment on the DES
                # page. Losing them must never lose the whole DES response.
                log.debug("des: finnhub enrichment failed for %s", symbol_key, exc_info=True)
        try:
            entry = await _yahoo_chart(rt, inst.yahoo, "1wk", "1y")
            if entry:
                meta = entry.get("meta") or {}
                quote = ((entry.get("indicators") or {}).get("quote") or [{}])[0]
                closes = [c for c in (quote.get("close") or []) if c]
                if meta:
                    # .update(), NOT `extra = {...}`. The original assignment
                    # nuked the finnhub profile + fundamentals fetched above,
                    # so the DES panel silently lost them whenever Yahoo
                    # answered — which is almost always. That is the whole
                    # point of a detail panel and it was being deleted.
                    extra.update({
                        "exchange": meta.get("exchangeName"),
                        "currency": meta.get("currency"),
                        "instrument_type": meta.get("instrumentType"),
                        "full_name": meta.get("longName") or meta.get("shortName"),
                    })
                if closes:
                    extra["week52_high"] = round(max(closes), 4)
                    extra["week52_low"] = round(min(closes), 4)
                    extra["year_return_pct"] = round((closes[-1] / closes[0] - 1) * 100, 2)
        except HTTPException:
            raise
        except Exception:
            log.debug("des: yahoo 1y fetch failed for %s", symbol_key, exc_info=True)
    # NOTE: fires/journal are filtered from the *global* recent window — an
    # unpopular symbol can miss old entries. Acceptable for a "recent" rail;
    # a proper store.query_by_symbol() is on the backlog.
    fires = [
        f for f in rt.store.alert_fires(200) if f.get("symbol_key") == symbol_key
    ]
    journal = [
        e for e in rt.store.journal(200) if e.get("symbol_key") == symbol_key
    ]
    return {
        "symbol_key": symbol_key,
        "asset_class": inst.asset_class,
        "ticker": inst.ticker,
        "state": state,
        "extra": extra,
        "peers": peers[:12],
        "recent_fires": fires[:5],
        "journal": journal[:5],
    }


class OrderSubmit(BaseModel):
    symbol_key: str
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop", "stop_limit"]
    qty: float = Field(gt=0)
    limit_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    tif: Literal["gtc", "day", "ioc"] = "gtc"
    venue: Literal["paper", "alpaca"] = "paper"


class OrderAmend(BaseModel):
    qty: float | None = None
    limit_price: float | None = None


class CashMove(BaseModel):
    amount: float


class JournalAdd(BaseModel):
    symbol_key: str
    text: str
    tags: str = ""


@api_router.post("/orders")
async def orders_submit(request: Request, body: OrderSubmit) -> dict[str, Any]:
    rt = request.app.state.runtime
    if body.venue == "alpaca":
        if rt.alpaca is None:
            raise HTTPException(
                status_code=400,
                detail="Alpaca keys not configured — add them in the Keys modal",
            )
        try:
            from ..providers.alpaca import order_payload

            payload = order_payload(
                body.symbol_key,
                body.side,
                body.type,
                body.qty,
                limit_price=body.limit_price,
                stop_price=body.stop_price,
                tif=body.tif,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        try:
            return await rt.alpaca.submit_order(payload)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Alpaca: {exc}") from exc
    try:
        row = rt.broker.submit(
            body.symbol_key,
            body.side,
            body.type,
            body.qty,
            limit_price=body.limit_price,
            stop_price=body.stop_price,
            tif=body.tif,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {k: v for k, v in row.items()}


@api_router.get("/orders")
async def orders_get(request: Request, status: str | None = None) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    return rt.store.get_orders(status)


@api_router.delete("/orders/{order_id}")
async def orders_cancel(request: Request, order_id: int) -> dict[str, bool]:
    rt = request.app.state.runtime
    if not rt.broker.cancel(order_id):
        raise HTTPException(status_code=400, detail="not cancellable")
    return {"canceled": True}


@api_router.patch("/orders/{order_id}")
async def orders_amend(request: Request, order_id: int, body: OrderAmend) -> dict[str, Any]:
    rt = request.app.state.runtime
    try:
        return rt.broker.amend(order_id, qty=body.qty, limit_price=body.limit_price)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@api_router.get("/portfolio")
async def portfolio_get(request: Request) -> dict[str, Any]:
    return request.app.state.runtime.broker.portfolio()


@api_router.get("/fills")
async def fills_get(request: Request, limit: int = 200) -> list[dict[str, Any]]:
    # max(1, …) FIRST: SQLite reads a negative LIMIT as "no limit", so the old
    # min(limit, 500) turned ?limit=-9999 into an unbounded fetch.
    return request.app.state.runtime.store.get_fills(max(1, min(limit, 500)))


@api_router.get("/alpaca/orders")
async def alpaca_orders_get(
    request: Request, status: str | None = None
) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    if rt.alpaca is None:
        raise HTTPException(status_code=400, detail="Alpaca keys not configured")
    try:
        return await rt.alpaca.orders(status=status, limit=100)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Alpaca: {exc}") from exc


@api_router.delete("/alpaca/orders/{order_id}")
async def alpaca_orders_cancel(request: Request, order_id: str) -> dict[str, bool]:
    rt = request.app.state.runtime
    if rt.alpaca is None:
        raise HTTPException(status_code=400, detail="Alpaca keys not configured")
    try:
        canceled = await rt.alpaca.cancel_order(order_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Alpaca: {exc}") from exc
    if not canceled:
        raise HTTPException(status_code=400, detail="not cancellable")
    return {"canceled": True}


@api_router.get("/alpaca/portfolio")
async def alpaca_portfolio_get(request: Request) -> dict[str, Any]:
    rt = request.app.state.runtime
    if rt.alpaca is None:
        raise HTTPException(status_code=400, detail="Alpaca keys not configured")
    try:
        return await rt.alpaca.portfolio()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Alpaca: {exc}") from exc


@api_router.get("/analytics")
async def analytics_get(request: Request) -> dict[str, Any]:
    return request.app.state.runtime.broker.analytics()


@api_router.post("/cash")
async def cash_post(request: Request, body: CashMove) -> dict[str, Any]:
    rt = request.app.state.runtime
    if body.amount == 0:
        raise HTTPException(status_code=400, detail="amount must be nonzero")
    rt.store.add_cash(body.amount, "manual")
    rt.broker._load_cash_only()
    return rt.broker.portfolio()


@api_router.post("/journal")
async def journal_add(request: Request, body: JournalAdd) -> dict[str, int]:
    rt = request.app.state.runtime
    return {"id": rt.store.add_journal(body.symbol_key, body.text, body.tags)}


@api_router.get("/journal")
async def journal_get(request: Request) -> list[dict[str, Any]]:
    return request.app.state.runtime.store.journal()


@api_router.delete("/journal/{entry_id}")
async def journal_delete(request: Request, entry_id: int) -> dict[str, bool]:
    rt = request.app.state.runtime
    return {"removed": rt.store.remove_journal(entry_id)}


# ── user preferences: keybindings / layouts / workspaces ─────────────────
#
# These three resources were hand-copy-pasted three times, and two of the
# copies were broken IN DIFFERENT WAYS: the DELETE decorators had no function
# body under them (old routes.py:694/727), which silently stacked a second
# route onto `layouts_get`/`workspaces_get` — so `DELETE /keybindings/{id}`
# returned a list of layouts and deleted nothing — while the real
# keybindings_delete/layouts_delete sat below, orphaned and unrouted.
# One factory, three mounts. If you are tempted to "just add a field" again:
# you will break it differently than the last three times. Trust me.


class _PrefsBody(BaseModel):
    """Accepts {name, bindings} (keybindings) or {name, config} (layouts/workspaces).

    The frontend uses the store's field names, so we accept either key and let
    value_field decide which one is authoritative — no coordinated UI change.
    """
    name: str = Field(min_length=1, max_length=200)
    bindings: str | None = None
    config: str | None = None

    def value(self, value_field: str) -> str:
        v = getattr(self, value_field, None) or ""
        if not v.strip():
            raise HTTPException(status_code=400, detail=f"{value_field} is required")
        return v.strip()


def _mount_prefs_crud(
    *,
    path: str,
    value_field: str,
    list_m: str,
    add_m: str,
    update_m: str,
    remove_m: str,
) -> None:
    """Register GET/POST/PUT/DELETE for a name+value preferences table.

    Store methods are referenced by NAME and resolved per request against
    request.app.state.runtime.store, because the store lives on the runtime
    (created in lifespan), not at import time.
    """

    def _store(request: Request):
        return request.app.state.runtime.store

    @api_router.get(path)
    async def _get(request: Request, name: str | None = None) -> list[dict[str, Any]]:
        return getattr(_store(request), list_m)(name)

    @api_router.post(path)
    async def _post(request: Request, body: _PrefsBody) -> dict[str, Any]:
        val = body.value(value_field)
        new_id = getattr(_store(request), add_m)(body.name.strip(), val)
        return {"id": new_id, "name": body.name.strip(), value_field: val}

    @api_router.put(path + "/{item_id}")
    async def _put(request: Request, item_id: int, body: _PrefsBody) -> dict[str, Any]:
        val = body.value(value_field)
        ok = getattr(_store(request), update_m)(item_id, body.name.strip(), val)
        if not ok:
            raise HTTPException(status_code=404, detail=f"{path.strip('/')} not found")
        return {"id": item_id, "name": body.name.strip(), value_field: val}

    @api_router.delete(path + "/{item_id}")
    async def _delete(request: Request, item_id: int) -> dict[str, bool]:
        return {"removed": getattr(_store(request), remove_m)(item_id)}


_mount_prefs_crud(
    path="/keybindings", value_field="bindings",
    list_m="keybindings", add_m="add_keybinding",
    update_m="update_keybinding", remove_m="remove_keybinding",
)
_mount_prefs_crud(
    path="/layouts", value_field="config",
    list_m="layouts", add_m="add_layout",
    update_m="update_layout", remove_m="remove_layout",
)
_mount_prefs_crud(
    path="/workspaces", value_field="config",
    list_m="workspaces", add_m="add_workspace",
    update_m="update_workspace", remove_m="remove_workspace",
)


@api_router.get("/universe")
async def universe_get(request: Request) -> list[dict[str, Any]]:
    rt = request.app.state.runtime
    rows = []
    for key, (inst, _tags) in sorted(rt._watched.items()):
        st = rt.market_state.get(key) or {}
        if st.get("last") is None:
            continue
        vol = st.get("volume")
        last = st.get("last")
        meta = rt.universe_meta.get(key) or {}
        rows.append({
            "symbol_key": key,
            "ticker": inst.ticker,
            "asset_class": inst.asset_class,
            "sector": meta.get("sector"),
            "industry": meta.get("industry"),
            "market_cap_m": meta.get("market_cap_m"),
            "last": last,
            "change_pct": st.get("change_pct"),
            "volume": vol,
            "notional": round(vol * last, 0) if vol and last else None,
            "day_high": st.get("day_high"),
            "day_low": st.get("day_low"),
        })
    return rows


async def _returns_matrix(
    rt, keys: list[str], interval: str, lookback: int,
) -> dict[str, list[float]]:
    """Fetch closes per key and convert to simple returns.

    Symbols with too little history are dropped (a half-filled row would poison
    the matrix). Returns are used instead of prices because correlating price
    levels across assets mostly measures drift, not comovement.

    History: this file used to have TWO correlation endpoints with THREE
    different math conventions (Pearson on returns here, a "price factor" fed
    into a streaming engine whose update() compared a price against a stored
    return — yes, really — there, and zero-padded numpy corrcoef as the engine
    "fallback" that could never be reached). The streaming engine was deleted;
    both endpoints now share this one honest path.
    """
    series: dict[str, list[float]] = {}
    for key in keys:
        try:
            bars = await rt.history.bars(key, interval, lookback + 1)
        except HTTPException:
            raise
        except Exception:
            log.debug("correlation: bars fetch failed for %s", key, exc_info=True)
            continue
        closes = [b["c"] for b in bars if b.get("c") is not None]
        if len(closes) >= 5:
            series[key] = [
                closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))
            ]
    return series


@api_router.get("/correlation")
async def correlation_get(
    request: Request,
    symbols: str,
    interval: str = "1d",
    lookback: int = 60,
) -> dict[str, Any]:
    rt = request.app.state.runtime
    keys = []
    for raw in symbols.split(","):
        key = raw.strip().upper()
        if from_key(key):
            keys.append(key)
    keys = keys[:MAX_CORR_SYMBOLS]
    lookback = max(10, min(lookback, 250))
    series = await _returns_matrix(rt, keys, interval, lookback)
    syms, matrix = correlation_matrix(series)
    return {"symbols": syms, "matrix": matrix}


@api_router.get("/correlation/rolling")
async def rolling_correlation(
    request: Request,
    symbols: str,
    lookback: int = 60,
) -> dict[str, Any]:
    """Same matrix computation, daily bars, up to 50 symbols.

    Kept as a separate route because the frontend contract references it; the
    body is intentionally identical logic to /correlation with fixed interval.
    """
    rt = request.app.state.runtime
    keys = []
    for raw in symbols.split(","):
        key = raw.strip().upper()
        if from_key(key):
            keys.append(key)
    keys = keys[:50]
    lookback = max(10, min(lookback, 250))
    series = await _returns_matrix(rt, keys, "1d", lookback)
    syms, matrix = correlation_matrix(series)
    return {"symbols": syms, "matrix": matrix}


class OptionGreeksResponse(BaseModel):
    symbol: str
    strike: float
    option_type: str
    expiry_days: int
    rate: float | None = None
    iv: float | None = None
    greeks: dict[str, float | None]


# Options chains API
options_router = APIRouter(tags=["options"])


@options_router.get("/greeks/{symbol}/{strike}", response_model=OptionGreeksResponse)
async def option_greeks_api(
    request: Request,
    symbol: str,
    strike: float,
    option_type: Literal["call", "put"] = "call",
    expiry_days: int = 30,
    rate: float = 0.05,
    iv: float | None = None,
) -> dict[str, Any]:
    """Get Black-Scholes Greeks for an option."""
    rt = request.app.state.runtime
    strike = max(strike, 0.01)
    expiry_days = max(1, min(expiry_days, 730))
    rate = max(0.0, min(rate, 1.0))
    # Spot resolution: live quote first, Yahoo as fallback. If BOTH miss, we
    # used to silently compute greeks against spot=100.0 — a plausible-looking
    # wall of numbers for an option whose real underlying might be $3. That is
    # worse than an error: 404 instead.
    inst = from_key(symbol)
    spot = None
    if inst and rt.market_state.get(symbol, {}).get("last"):
        spot = rt.market_state[symbol]["last"]
    elif inst and inst.yahoo:
        try:
            entry = await _yahoo_chart(rt, inst.yahoo, "1d", "1d")
            if entry:
                spot = (entry.get("meta") or {}).get("regularMarketPrice")
        except HTTPException:
            raise
        except Exception:
            log.debug("greeks: yahoo spot lookup failed for %s", symbol, exc_info=True)
    if not spot:
        raise HTTPException(
            status_code=404,
            detail=f"no spot price available for {symbol} — cannot compute greeks honestly",
        )

    greeks = compute_greeks(
        spot=spot,
        strike=strike,
        expiry_days=expiry_days,
        rate=rate,
        iv=iv,
        option_type=option_type,
    )
    return {
        "symbol": symbol,
        "strike": strike,
        "option_type": option_type,
        "expiry_days": expiry_days,
        "rate": rate,
        "iv": iv,
        "greeks": greeks,
    }


@options_router.get("/chains/{symbol:path}")
async def option_chains(
    request: Request,
    symbol: str,
) -> dict[str, Any]:
    rt = request.app.state.runtime
    # Tickers reaching here are interpolated into Finnhub/Yahoo URL paths; keep
    # it to plain equity symbols so nobody can smuggle a path segment through.
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,12}", symbol):
        raise HTTPException(status_code=422, detail="invalid symbol format")
    service = OptionsService(rt.http, rt.settings.finnhub_key)
    chain = await service.get_chain(symbol)
    if chain is None:
        raise HTTPException(status_code=404, detail=f"options chain not available for {symbol}")
    return chain


class ScriptRunIn(BaseModel):
    code: str = Field(min_length=1, max_length=200_000)
    symbols: str = ""


@api_router.post("/scripts/run")
async def scripts_run(request: Request, body: ScriptRunIn) -> ScriptRunResult:
    """Execute Python in a resource-limited SUBPROCESS as the server user.

    NOT a sandbox. See services/scripting.py for why. Local trust model:
    anyone who can reach this endpoint can run code as you. The server binds
    127.0.0.1 by default; never expose it (origin guard covers browser
    drive-bys, not a local process).
    """
    rt = request.app.state.runtime
    syms = [s.strip() for s in body.symbols.split(",") if s.strip()][:20]
    return await rt.scripting.run(body.code, syms)


@api_router.post("/scripts/close")
async def scripts_close(request: Request) -> dict[str, bool]:
    """Reset the scripting pool (drops queued runs; in-flight ones finish)."""
    rt = request.app.state.runtime
    await rt.scripting.reset()
    return {"ok": True}


api_router.include_router(bots_router)



