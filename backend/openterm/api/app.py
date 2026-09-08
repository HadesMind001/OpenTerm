"""FastAPI app factory.

Trust model (read before exposing this beyond localhost):
  * Default bind is 127.0.0.1 — there is NO authentication. This is a single-
    user local trading terminal, not a service. See SECURITY.md.
  * The origin guard below exists because CORS does NOT protect everything:
    a random website cannot read responses, but it CAN fire no-cors form POSTs
    (which mutate: place orders, overwrite API keys, run scripts) and open
    WebSockets to us — WS has no CORS at all. So we reject requests carrying a
    foreign Origin header instead of pretending preflight "protects" us.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..runtime import Runtime
from .app_guard import origin_allowed
from .routes import api_router, options_router
from .ws_gateway import websocket_endpoint


class LocalOriginGuard(BaseHTTPMiddleware):
    """Reject requests from web pages that were not served by OpenTerm itself.

    See app_guard.py for the full rationale.
    """

    async def dispatch(self, request: Request, call_next):
        if not origin_allowed(request.headers.get("origin")):
            return JSONResponse(
                status_code=403,
                content={"detail": "cross-origin request blocked (local app; see SECURITY.md)"},
            )
        return await call_next(request)


def _dist_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "frontend" / "dist"


def create_app(db_path: str | Path | None = None,
               with_providers: bool = True) -> FastAPI:
    runtime = Runtime(db_path=db_path, with_providers=with_providers)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> Iterator[None]:
        await runtime.start()
        yield
        await runtime.stop()

    app = FastAPI(title="OpenTerm", version="0.1.0", lifespan=lifespan)
    app.state.runtime = runtime
    app.add_middleware(LocalOriginGuard)
    app.include_router(api_router, prefix="/api")
    app.include_router(options_router, prefix="/api/options")
    app.add_api_websocket_route("/ws", websocket_endpoint)

    dist = _dist_dir()
    index = dist / "index.html"
    if index.exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="spa")
    else:

        @app.get("/")
        async def root() -> dict[str, str]:
            return {"name": "OpenTerm", "status": "backend-only (frontend/dist missing)"}

    return app