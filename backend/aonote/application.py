from __future__ import annotations

import asyncio
import logging
import sqlite3
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from time import perf_counter
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .api import create_api_router
from .config import Settings
from .db import Database
from .mcp import create_mcp_router
from .oauth import create_oauth_router
from .observability import configure_logging, log_event, probe_readiness, request_id, storage_error_code


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    configure_logging()
    active_settings = settings or Settings.from_env()
    database = Database(active_settings.database_path)
    database.initialize()

    async def monitor(app):
        previous = None
        while True:
            result = await run_in_threadpool(
                probe_readiness, database, app.state.static_dir, active_settings.min_free_disk_mb,
            )
            if result["checks"] != previous:
                log_event(
                    "readiness_changed", checks=result["checks"],
                    free_disk_bytes=result["free_disk_bytes"],
                    level=logging.INFO if result["status"] == "ok" else logging.WARNING,
                )
                previous = result["checks"]
            await asyncio.sleep(active_settings.monitor_interval_seconds)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(monitor(app))
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="aonote",
        description="Markdown workspace API and OAuth-protected MCP server",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = active_settings
    app.state.db = database
    app.add_middleware(GZipMiddleware, minimum_size=700)
    app.include_router(create_oauth_router(active_settings, database))
    app.include_router(create_api_router(active_settings, database))
    app.include_router(create_mcp_router(active_settings, database))

    @app.exception_handler(sqlite3.Error)
    async def database_error(request, error):
        reason = storage_error_code(error)
        log_event("storage_error", level=logging.ERROR, reason=reason)
        headers = {"Retry-After": "1", "Cache-Control": "no-store"}
        if request.url.path == "/oauth/token":
            body = {"error": "temporarily_unavailable"}
        else:
            body = {"detail": "Database temporarily unavailable", "code": reason}
        return JSONResponse(body, status_code=503, headers=headers)

    @app.middleware("http")
    async def security_headers(request, call_next):
        trace = uuid4().hex
        context = request_id.set(trace)
        started = perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
        except Exception as error:
            # Exception messages may contain SQL, user input, or credentials.
            log_event("request_error", level=logging.ERROR, reason=type(error).__name__)
            response = JSONResponse({"detail": "Internal server error"}, status_code=500)
        finally:
            route = request.scope.get("route")
            route_name = getattr(route, "name", "unmatched")
            if route_name not in {"health", "ready"} or status_code >= 400:
                log_event(
                    "http_request", route=route_name, status=status_code,
                    duration_ms=round((perf_counter() - started) * 1000, 2),
                )
            request_id.reset(context)
        response.headers["X-Request-ID"] = trace
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        return response

    static_dir = Path(__file__).resolve().parent / "static"
    app.state.static_dir = static_dir
    assets_dir = static_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/healthz", include_in_schema=False)
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "aonote"})

    @app.get("/readyz", include_in_schema=False)
    def ready() -> JSONResponse:
        result = probe_readiness(database, app.state.static_dir, active_settings.min_free_disk_mb)
        return JSONResponse(
            result, status_code=200 if result["status"] == "ok" else 503,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        index = static_dir / "index.html"
        if index.exists():
            return FileResponse(index)
        return JSONResponse(
            {"message": "Frontend is not built. Run npm install && npm run build."},
            status_code=503,
        )

    return app
