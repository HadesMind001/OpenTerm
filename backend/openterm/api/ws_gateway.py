"""WebSocket gateway: the one long-lived pipe between bus and browser.

Message protocol (JSON, one object per text frame):
  server → client:
    {"t":"hello", snapshot, statuses, news}   — sent once on connect
    {"t":"e", topic, data}                    — every subscribed event
    {"t":"pong"}                              — reply to ping
  client → server:
    {"action":"sub", patterns:[...]}          — replace market patterns
    {"action":"sub_bot", patterns:[...]}      — replace bot patterns
    {"action":"ping"}                         — keepalive (THE CLIENT MUST SEND IT:
                                                a half-open TCP can hang for minutes
                                                before onclose fires)
    {"action":"binary"} | "__binary__"        — switch event payloads to msgpack+zstd
                                                 binary frames (see ws_codec.py)

Binary-mode events use the wire format in ws_codec.py; hello is ALWAYS JSON
even after switching to binary — the frontend decodes accordingly.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
from datetime import datetime
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .ws_codec import decode_frame, encode_event, encode_pong
from .app_guard import origin_allowed

log = logging.getLogger(__name__)

DEFAULT_PATTERNS = [
    "tick:*", "quote:*", "stats:*", "bar:*", "news:*",
    "status:*", "depth:*",
]

# Bot event patterns that get mirrored to WebSocket
BOT_PATTERNS = [
    "bot:*",
]

# Cap for JSON the client may push at us. Commands are tiny (sub/ping); 64 KB
# is already generous for someone pasting a whole strategy as an "action".
_MAX_INBOUND = 64 * 1024


def _serialize_for_json(obj: Any) -> Any:
    """Recursively convert datetime to ISO strings for JSON serialization."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _serialize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize_for_json(v) for v in obj]
    return obj


async def websocket_endpoint(ws: WebSocket) -> None:
    # Browser pages on other origins must not be able to open our socket —
    # WS traffic is NOT covered by CORS, so without this any website you visit
    # could read your whole tape/watch feed and push commands. See app_guard.
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=4403)
        return

    runtime = ws.app.state.runtime
    await ws.accept()

    use_binary = False
    patterns: set[str] = set(DEFAULT_PATTERNS)
    bot_patterns: set[str] = set(BOT_PATTERNS)

    sub = None

    async def sender() -> None:
        assert sub is not None
        while True:
            topic, event = await sub.queue.get()
            if any(fnmatch.fnmatchcase(topic, p) for p in bot_patterns):
                # Bot lifecycle events: mirror under "bot.<id>" for the frontend
                data = event.model_dump(mode="json")
                await ws.send_json(
                    {"t": "e", "topic": topic.replace("bot:", "bot.", 1), "data": data}
                )
            elif any(fnmatch.fnmatchcase(topic, p) for p in patterns):
                data = event.model_dump(mode="json")
                if use_binary:
                    await ws.send_bytes(encode_event(topic, data))
                else:
                    await ws.send_json({"t": "e", "topic": topic, "data": data})

    async def receiver() -> None:
        nonlocal use_binary
        while True:
            try:
                msg = await ws.receive()
            except WebSocketDisconnect:
                break

            if "text" in msg:
                raw = msg["text"] or ""
                if len(raw) > _MAX_INBOUND:
                    # Command frames are tiny. A megabyte of "text" is either
                    # a confused client or someone poking us; drop the line,
                    # not our memory.
                    log.debug("ws: oversized inbound frame (%d B) ignored", len(raw))
                    continue
                if raw == "__binary__":
                    use_binary = True
                    continue
                try:
                    msg_data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg_data, dict):
                    continue
            elif "bytes" in msg:
                # Clients do not send binary commands (the protocol is JSON
                # upstream). The old code tried to iterate decode_frame()'s
                # single (type, topic, payload) TUPLE as a list of frames —
                # ValueError on every binary message, killing the connection.
                # Decode it honestly: validate the frame, then ignore it.
                try:
                    _ftype, _topic, _payload = decode_frame(msg["bytes"])
                except ValueError:
                    log.debug("ws: dropped malformed binary command")
                continue
            else:
                continue

            action = msg_data.get("action")
            if action == "sub":
                patterns.clear()
                patterns.update(msg_data.get("patterns") or DEFAULT_PATTERNS)
            elif action == "sub_bot":
                bot_patterns.clear()
                bot_patterns.update(msg_data.get("patterns") or BOT_PATTERNS)
            elif action == "ping":
                if use_binary:
                    await ws.send_bytes(encode_pong())
                else:
                    await ws.send_json({"t": "pong"})
            elif action == "binary":
                use_binary = True

    sub = runtime.bus.subscribe("*", maxsize=2000)
    send_task: asyncio.Task | None = None
    try:
        # Hello must be INSIDE the try that owns the unsubscribe. Previously
        # subscribe() ran, then a bare await send_json() — if the browser had
        # already vanished (it happens on hot-reload), that raise skipped the
        # finally, leaking the subscription (and its 2000-item queue) onto the
        # bus for the life of the server. Every reload leaked another one.
        snapshot = {
            k: _serialize_for_json(v)
            for k, v in runtime.market_state.snapshot().items()
            if v.get("last") is not None
        }
        await ws.send_json({
            "t": "hello",
            "snapshot": snapshot,
            "statuses": runtime.statuses(),
            "news": {
                k: [n.model_dump(mode="json") for n in list(v)[:30]]
                for k, v in runtime.news.items()
            },
        })

        send_task = asyncio.create_task(sender())
        try:
            await receiver()
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            log.exception("ws gateway error")
    finally:
        if send_task is not None:
            send_task.cancel()
            # gather(return_exceptions) drains the task without swallowing OUR
            # own cancellation (the old `except (CancelledError, Exception):
            # pass` around the await did exactly that).
            await asyncio.gather(send_task, return_exceptions=True)
        if sub is not None:
            runtime.bus.unsubscribe(sub)
