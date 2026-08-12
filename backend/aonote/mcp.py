from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import JSONResponse

from .config import Settings
from .db import Database, VersionConflict
from .oauth import validate_oauth_token
from .security import bearer_token


PROTOCOL_VERSION = "2025-06-18"


def _tool(
    name: str,
    description: str,
    schema: Dict[str, Any],
    read_only: bool = True,
    destructive: bool = False,
) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": schema,
        "annotations": {
            "title": name.replace("_", " ").title(),
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": read_only,
            "openWorldHint": False,
        },
    }


TOOLS = [
    _tool(
        "list_notes",
        "List recent Markdown notes. Use this to browse before opening a note.",
        {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 50}}},
    ),
    _tool(
        "get_note",
        "Read one complete Markdown note by its aonote note ID or workspace-relative path.",
        {
            "type": "object",
            "properties": {
                "note_id": {"type": "string", "description": "Stable aonote note ID"},
                "path": {
                    "type": "string",
                    "description": "Case-sensitive workspace path such as ようこそ/01-ようこそ.md; use only the filename for 未整理",
                },
            },
            "oneOf": [{"required": ["note_id"]}, {"required": ["path"]}],
        },
    ),
    _tool(
        "list_folders",
        "List workspace folders with IDs, parent IDs, and nesting depth. Use before moving a note.",
        {"type": "object", "properties": {}},
    ),
    _tool(
        "search_notes",
        "Search note titles, filenames, and Markdown bodies with SQLite FTS5 keyword search.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "required": ["query"],
        },
    ),
    _tool(
        "create_note",
        "Create a Markdown note. Include a clear H1 heading in content.",
        {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Filename ending in .md"},
                "content": {"type": "string"},
                "folder_id": {"type": ["string", "null"]},
            },
            "required": ["filename", "content"],
        },
        read_only=False,
    ),
    _tool(
        "update_note",
        "Update a note using its current version for conflict-safe editing. Read the note first.",
        {
            "type": "object",
            "properties": {
                "note_id": {"type": "string"},
                "content": {"type": "string"},
                "version": {"type": "integer", "minimum": 1},
                "filename": {"type": "string"},
            },
            "required": ["note_id", "content", "version"],
        },
        read_only=False,
    ),
    _tool(
        "rename_note",
        "Rename a Markdown note using its current version for conflict safety.",
        {
            "type": "object",
            "properties": {
                "note_id": {"type": "string"},
                "filename": {"type": "string", "description": "New Markdown filename"},
                "version": {"type": "integer", "minimum": 1},
            },
            "required": ["note_id", "filename", "version"],
        },
        read_only=False,
    ),
    _tool(
        "move_note",
        "Move a note to a folder. Use list_folders first; pass null to move it to 未整理.",
        {
            "type": "object",
            "properties": {
                "note_id": {"type": "string"},
                "folder_id": {"type": ["string", "null"]},
                "version": {"type": "integer", "minimum": 1},
            },
            "required": ["note_id", "folder_id", "version"],
        },
        read_only=False,
    ),
    _tool(
        "delete_note",
        "Permanently delete a note. Use only after explicit user confirmation.",
        {
            "type": "object",
            "properties": {"note_id": {"type": "string"}},
            "required": ["note_id"],
        },
        read_only=False,
        destructive=True,
    ),
]


def _result(value: Any, is_error: bool = False) -> Dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False, indent=2)
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if not is_error and isinstance(value, (dict, list)):
        result["structuredContent"] = value if isinstance(value, dict) else {"items": value}
    return result


def create_mcp_router(settings: Settings, db: Database) -> APIRouter:
    router = APIRouter()

    def challenge() -> JSONResponse:
        metadata = f"{settings.base_url}/.well-known/oauth-protected-resource"
        return JSONResponse(
            {"error": "unauthorized", "error_description": "OAuth access token required"},
            status_code=401,
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", scope="notes:read notes:search notes:write"'},
        )

    @router.post("/mcp")
    async def mcp_post(
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ) -> Response:
        token = bearer_token(authorization)
        principal = validate_oauth_token(db, token or "", settings.mcp_resource) if token else None
        if not principal:
            return challenge()
        try:
            message = await request.json()
        except Exception:
            return JSONResponse(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
                status_code=400,
            )
        if isinstance(message, list):
            responses = [handle_message(item, principal) for item in message]
            return JSONResponse([item for item in responses if item is not None])
        result = handle_message(message, principal)
        if result is None:
            return Response(status_code=202)
        return JSONResponse(result)

    @router.get("/mcp")
    async def mcp_get(authorization: Optional[str] = Header(default=None)) -> Response:
        token = bearer_token(authorization)
        if not token or not validate_oauth_token(db, token, settings.mcp_resource):
            return challenge()
        return JSONResponse(
            {"error": "This stateless server accepts MCP messages with POST."},
            status_code=405,
            headers={"Allow": "POST, DELETE"},
        )

    @router.delete("/mcp", status_code=204)
    async def mcp_delete() -> Response:
        return Response(status_code=204)

    def handle_message(message: Dict[str, Any], principal: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        request_id = message.get("id")
        method = message.get("method")
        if method and method.startswith("notifications/"):
            return None
        if message.get("jsonrpc") != "2.0" or not method:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid Request"}}
        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "aonote", "title": "aonote Markdown Workspace", "version": "0.1.0"},
                    "instructions": "Read a note directly with a known ID or copied workspace path; otherwise search or list first. Read a note before updating it and pass its version to prevent conflicts.",
                },
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
        if method == "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            arguments = params.get("arguments") or {}
            try:
                value = call_tool(name, arguments, principal)
                return {"jsonrpc": "2.0", "id": request_id, "result": _result(value)}
            except PermissionError as exc:
                return {"jsonrpc": "2.0", "id": request_id, "result": _result({"error": str(exc)}, True)}
            except (ValueError, sqlite3.IntegrityError, VersionConflict) as exc:
                return {"jsonrpc": "2.0", "id": request_id, "result": _result({"error": str(exc)}, True)}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}

    def require_scope(principal: Dict[str, Any], scope: str) -> None:
        if scope not in principal["scopes"]:
            raise PermissionError(f"OAuth scope required: {scope}")

    def call_tool(name: str, arguments: Dict[str, Any], principal: Dict[str, Any]) -> Any:
        actor = {
            "actor_name": principal["actor_name"],
            "client_name": principal["client_name"],
        }
        if name == "list_notes":
            require_scope(principal, "notes:read")
            notes = db.list_recent(max(1, min(int(arguments.get("limit", 20)), 50)))
            return [{key: note[key] for key in ("id", "title", "filename", "version", "updated_at")} for note in notes]
        if name == "get_note":
            require_scope(principal, "notes:read")
            note_id = str(arguments.get("note_id") or "").strip()
            note_path = str(arguments.get("path") or "").strip()
            if bool(note_id) == bool(note_path):
                raise ValueError("Provide exactly one of note_id or path")
            note = db.get_note(note_id) if note_id else db.get_note_by_path(note_path)
            if not note:
                raise ValueError("Note not found")
            return note
        if name == "list_folders":
            require_scope(principal, "notes:read")
            return db.list_folders()
        if name == "search_notes":
            require_scope(principal, "notes:search")
            query = str(arguments.get("query", "")).strip()
            if not query:
                raise ValueError("query is required")
            return db.search(query, max(1, min(int(arguments.get("limit", 10)), 50)))
        if name == "create_note":
            require_scope(principal, "notes:write")
            return db.create_note(
                str(arguments.get("filename", "")),
                str(arguments.get("content", "")),
                arguments.get("folder_id"),
                **actor,
            )
        if name == "update_note":
            require_scope(principal, "notes:write")
            note = db.update_note(
                str(arguments.get("note_id", "")),
                content=str(arguments.get("content", "")),
                filename=arguments.get("filename"),
                expected_version=int(arguments.get("version", 0)),
                **actor,
            )
            if not note:
                raise ValueError("Note not found")
            return note
        if name == "rename_note":
            require_scope(principal, "notes:write")
            current = db.get_note(str(arguments.get("note_id", "")))
            if not current:
                raise ValueError("Note not found")
            note = db.relocate_note(
                current["id"],
                str(arguments.get("filename", "")),
                current["folder_id"],
                int(arguments.get("version", 0)),
                **actor,
            )
            if not note:
                raise ValueError("Note not found")
            return note
        if name == "move_note":
            require_scope(principal, "notes:write")
            current = db.get_note(str(arguments.get("note_id", "")))
            if not current:
                raise ValueError("Note not found")
            note = db.relocate_note(
                current["id"],
                current["filename"],
                arguments.get("folder_id"),
                int(arguments.get("version", 0)),
                **actor,
            )
            if not note:
                raise ValueError("Note not found")
            return note
        if name == "delete_note":
            require_scope(principal, "notes:write")
            if not db.delete_note(str(arguments.get("note_id", ""))):
                raise ValueError("Note not found")
            return {"deleted": True}
        raise ValueError(f"Unknown tool: {name}")

    return router
