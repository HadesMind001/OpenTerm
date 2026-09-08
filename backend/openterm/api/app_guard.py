"""Shared origin validation for HTTP middleware and the WebSocket endpoint.

Why this exists at all: the API is unauthenticated BY DESIGN (single-user
local app). Browsers stop cross-origin pages from READING responses via CORS,
but they happily ALLOW:
  * `<form>` / no-cors POSTs (fire-and-forget mutations: place an order,
    overwrite your API keys, run a script), and
  * WebSockets to any host (CORS never applied to WS).
So "it's on localhost, I'm the only user" still has a drive-by hole: any page
you visit while OpenTerm runs can mutate state blind. Checking the Origin
header closes the browser half of that. (A local process can still do
anything it wants — see SECURITY.md for where the trust model actually ends.)
"""
from __future__ import annotations

from urllib.parse import urlparse

_ALLOWED_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def origin_allowed(origin: str | None) -> bool:
    """True if this request may proceed.

    None/empty origin (curl, native clients, same-origin non-fetch requests)
    is allowed — the guard targets *browsers from other pages*, not scripts,
    which already share the box with your trading DB anyway.
    """
    if not origin:
        return True
    try:
        host = urlparse(origin).hostname or ""
    except ValueError:
        return False
    return host in _ALLOWED_ORIGIN_HOSTS
