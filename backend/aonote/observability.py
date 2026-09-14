"""Operational checks and allowlisted logs; never log request bodies or tokens."""
from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path

from .db import Database


logger = logging.getLogger("aonote")
request_id: ContextVar[str] = ContextVar("aonote_request_id", default="")


def configure_logging() -> None:
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def log_event(event: str, *, level: int = logging.INFO, **fields) -> None:
    logger.log(level, json.dumps({
        "time": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "request_id": request_id.get(),
        **fields,
    }, ensure_ascii=False))


def storage_error_code(error: sqlite3.Error) -> str:
    # Extended SQLite codes retain the primary code in the low byte.
    code = getattr(error, "sqlite_errorcode", 0) & 0xFF
    return {
        sqlite3.SQLITE_BUSY: "database_busy",
        sqlite3.SQLITE_LOCKED: "database_busy",
        sqlite3.SQLITE_FULL: "disk_full",
        sqlite3.SQLITE_READONLY: "database_readonly",
        sqlite3.SQLITE_IOERR: "database_io_error",
    }.get(code, "database_unavailable")


def probe_readiness(db: Database, static_dir: Path, min_free_disk_mb: int) -> dict:
    checks = {"database": "ok", "frontend": "ok", "disk": "ok"}
    free_bytes = None
    try:
        # mode=rw refuses to create an empty replacement when the DB is missing.
        connection = sqlite3.connect(
            f"{db.path.resolve().as_uri()}?mode=rw", uri=True, timeout=1,
        )
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("SELECT id FROM notes LIMIT 1").fetchone()
            connection.execute("SELECT rowid FROM note_fts LIMIT 1").fetchone()
            if not os.access(db.path, os.W_OK) or not os.access(db.path.parent, os.W_OK):
                checks["database"] = "database_readonly"
        finally:
            try:
                connection.rollback()
            finally:
                connection.close()
    except sqlite3.Error as error:
        checks["database"] = storage_error_code(error)
    except OSError:
        checks["database"] = "database_unavailable"
    try:
        with (static_dir / "index.html").open("rb") as index:
            if not index.read(1):
                checks["frontend"] = "frontend_unavailable"
        if not (static_dir / "assets").is_dir() or not any((static_dir / "assets").glob("*.js")):
            checks["frontend"] = "frontend_unavailable"
    except OSError:
        checks["frontend"] = "frontend_unavailable"
    try:
        free_bytes = shutil.disk_usage(db.path.parent).free
        if free_bytes < min_free_disk_mb * 1024 * 1024:
            checks["disk"] = "low_disk_space"
    except OSError:
        checks["disk"] = "disk_unavailable"
    return {
        "status": "ok" if all(value == "ok" for value in checks.values()) else "not_ready",
        "service": "aonote",
        "checks": checks,
        "free_disk_bytes": free_bytes,
    }
