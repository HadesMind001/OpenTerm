"""Bot HTTP surface — a REST mask over a registry with no engine behind it.

WHAT IS REAL here: every row these routes read/write is a genuine SQLite
record (source persisted, state column, bot_logs table) and every lifecycle
change is a genuine EventBus publish — the WS feed you see in the browser is
honestly reporting the registry.

WHAT IS FAKE (deliberately, until bot-runtime/ grows a real executor):
- "Deploy" validates and stores source; no code is ever imported or run.
- start/stop/restart flip the state column and nothing else — a "running"
  bot computes nothing and trades nothing.
- The /{bot_id}/logs stream comes from SQLite bot_logs, which only the
  MANAGER writes (deploy lines, state changes). It is not the bot's stdout —
  there is no bot, there is no stdout. Reading it as one is how you end up
  "debugging" an empty process.
- stats (callbacks_executed, orders_placed, fuel_consumed...) are static
  zeros; BotStats is never incremented because there is nothing to
  increment it.

CALLERS/FRONTEND: treat bot state as COSMETIC — a saved intent, not a
process status. If you render a green "RUNNING" dot with no "(registry-only)"
caveat next to it, that lie is on you, not on bot_manager (whose module
docstring says EXPERIMENTAL/NON-FUNCTIONAL six ways to Sunday).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..services.bot_manager import (
    BotInfo, BotStatus, BotLogEntry, ExampleInfo,
)


class ExampleListResponse(BaseModel):
    examples: List[ExampleInfo]


class DeployExampleBody(BaseModel):
    example_id: str
    risk: str = "moderate"

router = APIRouter(prefix="/bots", tags=["bots (EXPERIMENTAL — registry only, no execution)"])


# ── Request models ─────────────────────────────────────────────────────
class DeployBody(BaseModel):
    source: str = Field(min_length=1, max_length=256_000)
    name: Optional[str] = None
    risk: str = "moderate"
    language: Optional[str] = None
    # `force` used to be accepted, validated by nobody and forwarded to
    # nothing while duplicate rows accumulated. It is simply gone: redeploying
    # the same source creates a new registry entry, deliberately.


class ConfigUpdateRequest(BaseModel):
    config: Dict[str, Any] = {}


class BotListResponse(BaseModel):
    bots: List[BotInfo]


class LogsResponse(BaseModel):
    logs: List[BotLogEntry]


def _manager(request: Request):
    return request.app.state.runtime.bot_manager


# ── Routes ─────────────────────────────────────────────────────────────
@router.post("/deploy", response_model=BotInfo)
async def deploy_bot(request: Request, body: DeployBody) -> BotInfo:
    """Deploy a new bot from source code."""
    try:
        return await _manager(request).deploy_bot(
            source=body.source,
            name=body.name,
            risk=body.risk,
            language=body.language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/examples", response_model=ExampleListResponse)
async def list_examples(request: Request) -> ExampleListResponse:
    """Bundled example strategies that can be deployed with one click."""
    examples = await _manager(request).list_examples()
    return ExampleListResponse(examples=examples)


@router.post("/deploy-example", response_model=BotInfo)
async def deploy_example(request: Request, body: DeployExampleBody) -> BotInfo:
    """Deploy a bundled example bot by id."""
    try:
        return await _manager(request).deploy_example(body.example_id, risk=body.risk)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("", response_model=BotListResponse)
async def list_bots(request: Request) -> BotListResponse:
    # The duplicate `GET "/"` registration is gone: prefix + "" already
    # answers /api/bots, and two routes for one endpoint is how they diverge.
    bots = await _manager(request).list_bots()
    return BotListResponse(bots=bots)


@router.post("/{bot_id}/start", response_model=BotInfo)
async def start_bot_by_id(request: Request, bot_id: str) -> BotInfo:
    try:
        return await _manager(request).start_bot(bot_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{bot_id}/stop", response_model=BotInfo)
async def stop_bot_by_id(request: Request, bot_id: str) -> BotInfo:
    try:
        return await _manager(request).stop_bot(bot_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{bot_id}/restart", response_model=BotInfo)
async def restart_bot(request: Request, bot_id: str) -> BotInfo:
    try:
        return await _manager(request).restart_bot(bot_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{bot_id}/status", response_model=BotStatus)
async def get_bot_status(request: Request, bot_id: str) -> BotStatus:
    try:
        return await _manager(request).get_bot_status(bot_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{bot_id}/logs", response_model=LogsResponse)
async def get_bot_logs(request: Request, bot_id: str, lines: int = 200) -> LogsResponse:
    logs = await _manager(request).get_bot_logs(bot_id, lines=lines)
    return LogsResponse(logs=logs)


@router.patch("/{bot_id}/config")
async def update_bot_config(
    request: Request, bot_id: str, body: ConfigUpdateRequest
) -> Dict[str, str]:
    try:
        await _manager(request).update_bot_config(bot_id, body.config)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"status": "updated", "bot_id": bot_id}


@router.delete("/{bot_id}")
async def delete_bot(request: Request, bot_id: str) -> Dict[str, Any]:
    removed = await _manager(request).delete_bot(bot_id)
    if not removed:
        raise HTTPException(status_code=404, detail="bot not found")
    return {"status": "deleted", "bot_id": bot_id}


@router.post("/stop-all")
async def stop_all_bots(request: Request) -> Dict[str, str]:
    await _manager(request).stop_all_bots()
    return {"status": "stopping all bots"}
