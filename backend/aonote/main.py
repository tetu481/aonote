from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import create_api_router
from .config import Settings
from .db import Database
from .mcp import create_mcp_router
from .oauth import create_oauth_router


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    active_settings = settings or Settings.from_env()
    database = Database(active_settings.database_path)
    database.initialize()

    app = FastAPI(
        title="aonote",
        description="Markdown workspace API and OAuth-protected MCP server",
        version="0.1.0",
    )
    app.state.settings = active_settings
    app.state.db = database
    app.add_middleware(GZipMiddleware, minimum_size=700)
    app.include_router(create_oauth_router(active_settings, database))
    app.include_router(create_api_router(active_settings, database))
    app.include_router(create_mcp_router(active_settings, database))

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        return response

    static_dir = Path(__file__).resolve().parent / "static"
    assets_dir = static_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/healthz", include_in_schema=False)
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "aonote"})

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


app = create_app()
