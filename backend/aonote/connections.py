"""Browser-only management of individual OAuth authorization grants."""
from __future__ import annotations

import json
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import Settings
from .db import Database
from .security import now_ts


Scope = Literal["notes:read", "notes:search", "notes:write"]


class ConnectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor_name: str = Field(min_length=1, max_length=80)
    scopes: list[Scope] = Field(min_length=1, max_length=3)
    version: int = Field(ge=1, strict=True)

    @field_validator("actor_name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Invalid display name")
        return value


def revoke_connection(connection: sqlite3.Connection, connection_id: str) -> None:
    # Called inside the same writer transaction as refresh/code exchange, so
    # concurrent token issuance cannot resurrect a revoked connection.
    connection.execute(
        """UPDATE oauth_connections SET revoked_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND revoked_at IS NULL""",
        (now_ts(), now_ts(), connection_id),
    )
    connection.execute("DELETE FROM oauth_codes WHERE connection_id = ?", (connection_id,))
    connection.execute("DELETE FROM oauth_tokens WHERE connection_id = ?", (connection_id,))


def _list_connections(connection: sqlite3.Connection, connection_id: str | None = None) -> list[dict]:
    rows = connection.execute(
        """SELECT g.*, c.client_name, c.redirect_uris,
                  (SELECT MAX(expires_at) FROM oauth_tokens WHERE connection_id = g.id) AS token_expires_at,
                  (SELECT MAX(expires_at) FROM oauth_codes WHERE connection_id = g.id) AS code_expires_at
           FROM oauth_connections g JOIN oauth_clients c ON c.client_id = g.client_id
           WHERE (? IS NULL OR g.id = ?)
           ORDER BY (g.revoked_at IS NOT NULL), COALESCE(g.created_at, g.updated_at) DESC, g.id""",
        (connection_id, connection_id),
    ).fetchall()
    stamp = now_ts()
    result = []
    for row in rows:
        state = "expired"
        if row["revoked_at"] is not None:
            state = "revoked"
        elif (row["token_expires_at"] or 0) > stamp:
            state = "active"
        elif (row["code_expires_at"] or 0) > stamp:
            state = "pending"
        # Explicit allowlist: never expose credential hashes or token values.
        result.append({
            "id": row["id"], "client_id": row["client_id"],
            "client_name": row["client_name"], "actor_name": row["actor_name"] or row["client_name"],
            "scopes": row["scope"].split(), "approved_scopes": row["approved_scope"].split(),
            "resource": row["resource"], "redirect_uris": json.loads(row["redirect_uris"]),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "last_used_at": row["last_used_at"], "revoked_at": row["revoked_at"],
            "expires_at": max(row["token_expires_at"] or 0, row["code_expires_at"] or 0) or None,
            "legacy": bool(row["legacy"]), "version": row["version"], "status": state,
        })
    return result


def create_connections_router(settings: Settings, db: Database) -> APIRouter:
    def require_admin(request: Request, response: Response) -> None:
        response.headers["Cache-Control"] = "no-store"
        # OAuth bearers must never be able to change their own permissions or
        # inspect/disconnect another AI. Only the browser administrator can.
        if not settings.dev_bypass_auth and not db.valid_session(request.cookies.get("aonote_session")):
            raise HTTPException(status_code=401, detail="Browser administrator session required")
        if request.method not in {"GET", "HEAD"}:
            # A custom header prevents simple cross-origin form submissions;
            # do not enable CORS for this API. Also reject sibling-site origins.
            if request.headers.get("X-Aonote-Request") != "connections":
                raise HTTPException(status_code=403, detail="Invalid management request")
            origin = request.headers.get("origin")
            if origin is not None and origin != settings.base_url.rstrip("/"):
                raise HTTPException(status_code=403, detail="Invalid request origin")
            if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
                raise HTTPException(status_code=403, detail="Invalid request origin")

    router = APIRouter(prefix="/api/connections", dependencies=[Depends(require_admin)])

    @router.get("")
    def list_connections() -> list[dict]:
        with db.connect() as connection:
            return _list_connections(connection)

    @router.patch("/{connection_id}")
    def update_connection(connection_id: str, payload: ConnectionUpdate) -> dict:
        with db.connect(write=True) as connection:
            row = connection.execute("SELECT * FROM oauth_connections WHERE id = ?", (connection_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Connection not found")
            if row["revoked_at"] is not None:
                raise HTTPException(status_code=409, detail="Connection revoked")
            if row["version"] != payload.version:
                raise HTTPException(status_code=409, detail="Connection changed; reload before editing")
            if not set(payload.scopes).issubset(row["approved_scope"].split()):
                raise HTTPException(status_code=400, detail="New permissions require OAuth consent")
            connection.execute(
                """UPDATE oauth_connections SET actor_name = ?, scope = ?, updated_at = ?,
                   version = version + 1 WHERE id = ?""",
                (payload.actor_name, " ".join(sorted(set(payload.scopes))), now_ts(), connection_id),
            )
            return _list_connections(connection, connection_id)[0]

    @router.delete("/{connection_id}", status_code=204)
    def disconnect(connection_id: str) -> Response:
        with db.connect(write=True) as connection:
            if not connection.execute("SELECT 1 FROM oauth_connections WHERE id = ?", (connection_id,)).fetchone():
                raise HTTPException(status_code=404, detail="Connection not found")
            revoke_connection(connection, connection_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return router
