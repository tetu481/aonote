from __future__ import annotations

import sqlite3
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field

from .config import Settings
from .db import Database, FolderDepthError, VersionConflict
from .oauth import validate_oauth_token
from .security import bearer_token, verify_password


class LoginInput(BaseModel):
    password: str


class FolderInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: Optional[str] = None


class FolderRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class NoteCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content: str = ""
    folder_id: Optional[str] = None


class NoteUpdate(BaseModel):
    content: Optional[str] = None
    filename: Optional[str] = Field(default=None, min_length=1, max_length=180)
    folder_id: Optional[str] = None
    version: Optional[int] = None


class NoteLocation(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    folder_id: Optional[str] = None
    version: int = Field(ge=1)


def create_api_router(settings: Settings, db: Database) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def require_user(
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ) -> Dict[str, Any]:
        if settings.dev_bypass_auth:
            return {"kind": "browser", "actor_name": "管理者", "client_name": None}
        if db.valid_session(request.cookies.get("aonote_session")):
            return {"kind": "browser", "actor_name": "管理者", "client_name": None}
        token = bearer_token(authorization)
        principal = (
            validate_oauth_token(db, token, settings.mcp_resource, "notes:read")
            if token else None
        )
        if principal:
            return {"kind": "oauth", **principal}
        raise HTTPException(status_code=401, detail="Authentication required")

    def require_write(principal: Dict[str, Any]) -> None:
        if principal["kind"] == "oauth" and "notes:write" not in principal["scopes"]:
            raise HTTPException(status_code=403, detail="notes:write scope required")

    def require_browser(principal: Dict[str, Any]) -> None:
        if principal["kind"] != "browser":
            raise HTTPException(status_code=403, detail="ゴミ箱はブラウザから操作してください")

    def actor(principal: Dict[str, Any]) -> Dict[str, Optional[str]]:
        return {
            "actor_name": principal["actor_name"],
            "client_name": principal.get("client_name"),
        }

    @router.post("/session")
    async def login(payload: LoginInput, response: Response) -> Dict[str, bool]:
        if not verify_password(payload.password, settings.admin_password):
            raise HTTPException(status_code=401, detail="パスワードが正しくありません")
        session = db.create_session(settings.session_ttl)
        response.set_cookie(
            "aonote_session",
            session,
            max_age=settings.session_ttl,
            httponly=True,
            secure=settings.base_url.startswith("https://"),
            samesite="strict",
        )
        return {"authenticated": True}

    @router.get("/status")
    async def app_status(_: Dict[str, Any] = Depends(require_user)) -> Dict[str, Any]:
        with db.connect() as connection:
            notes = connection.execute(
                "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL"
            ).fetchone()[0]
            folders = connection.execute("SELECT COUNT(*) FROM folders").fetchone()[0]
        return {
            "name": "aonote",
            "notes": notes,
            "folders": folders,
            "search": "SQLite FTS5 (trigram)",
            "mcp_endpoint": f"{settings.base_url}/mcp",
            "mcp_ready": True,
            "auth_bypassed": settings.dev_bypass_auth,
            "max_folder_depth": settings.max_folder_depth,
        }

    @router.get("/tree")
    async def tree(_: Dict[str, Any] = Depends(require_user)) -> Any:
        return db.list_tree()

    @router.get("/recent")
    async def recent(limit: int = 12, _: Dict[str, Any] = Depends(require_user)) -> Any:
        return db.list_recent(max(1, min(limit, 50)))

    @router.get("/notes/{note_id}")
    async def get_note(note_id: str, _: Dict[str, Any] = Depends(require_user)) -> Any:
        note = db.get_note(note_id)
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        return note

    @router.post("/notes", status_code=201)
    async def create_note(
        payload: NoteCreate, principal: Dict[str, Any] = Depends(require_user)
    ) -> Any:
        require_write(principal)
        try:
            return db.create_note(
                payload.filename, payload.content, payload.folder_id, **actor(principal)
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="同じ名前のノートがあります") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.patch("/notes/{note_id}")
    async def update_note(
        note_id: str,
        payload: NoteUpdate,
        principal: Dict[str, Any] = Depends(require_user),
    ) -> Any:
        require_write(principal)
        try:
            fields = payload.model_fields_set
            changes: Dict[str, Any] = {
                "content": payload.content,
                "filename": payload.filename,
                "expected_version": payload.version,
                **actor(principal),
            }
            if "folder_id" in fields:
                changes["folder_id"] = payload.folder_id
            note = db.update_note(
                note_id,
                **changes,
            )
        except VersionConflict as exc:
            raise HTTPException(
                status_code=409,
                detail={"message": "別のクライアントが更新しました", "current_version": exc.current_version},
            ) from exc
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="同じ名前のノートがあります") from exc
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        return note

    @router.patch("/notes/{note_id}/location")
    async def relocate_note(
        note_id: str,
        payload: NoteLocation,
        principal: Dict[str, Any] = Depends(require_user),
    ) -> Any:
        require_write(principal)
        try:
            note = db.relocate_note(
                note_id,
                payload.filename,
                payload.folder_id,
                payload.version,
                **actor(principal),
            )
        except VersionConflict as exc:
            raise HTTPException(
                status_code=409,
                detail={"message": "別のクライアントが更新しました", "current_version": exc.current_version},
            ) from exc
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="同じ名前のノートがあります") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        return note

    @router.delete("/notes/{note_id}", status_code=204)
    async def delete_note(
        note_id: str, principal: Dict[str, Any] = Depends(require_user)
    ) -> Response:
        require_write(principal)
        if not db.delete_note(note_id):
            raise HTTPException(status_code=404, detail="Note not found")
        return Response(status_code=204)

    @router.get("/trash")
    async def list_trash(principal: Dict[str, Any] = Depends(require_user)) -> Any:
        require_browser(principal)
        return db.list_trash()

    @router.get("/trash/{note_id}")
    async def get_trashed_note(
        note_id: str, principal: Dict[str, Any] = Depends(require_user)
    ) -> Any:
        require_browser(principal)
        note = db.get_trashed_note(note_id)
        if not note:
            raise HTTPException(status_code=404, detail="ゴミ箱にノートがありません")
        return note

    @router.post("/trash/{note_id}/restore")
    async def restore_trashed_note(
        note_id: str, principal: Dict[str, Any] = Depends(require_user)
    ) -> Any:
        require_browser(principal)
        try:
            note = db.restore_note(note_id)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail="復元先に同じ名前のノートがあります",
            ) from exc
        if not note:
            raise HTTPException(status_code=404, detail="ゴミ箱にノートがありません")
        return note

    @router.delete("/trash")
    async def purge_trash(
        older_than_days: int = Query(default=30, ge=0, le=36500),
        principal: Dict[str, Any] = Depends(require_user),
    ) -> Any:
        require_browser(principal)
        return {"deleted": db.purge_trash(older_than_days)}

    @router.post("/folders", status_code=201)
    async def create_folder(
        payload: FolderInput, principal: Dict[str, Any] = Depends(require_user)
    ) -> Any:
        require_write(principal)
        try:
            return db.create_folder(
                payload.name, payload.parent_id, settings.max_folder_depth
            )
        except FolderDepthError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"フォルダは最大{exc.max_depth}階層までです",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.patch("/folders/{folder_id}")
    async def rename_folder(
        folder_id: str,
        payload: FolderRename,
        principal: Dict[str, Any] = Depends(require_user),
    ) -> Any:
        require_write(principal)
        try:
            folder = db.rename_folder(folder_id, payload.name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        return folder

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_folder(
        folder_id: str, principal: Dict[str, Any] = Depends(require_user)
    ) -> Response:
        require_write(principal)
        if not db.delete_folder(folder_id):
            raise HTTPException(status_code=404, detail="Folder not found")
        return Response(status_code=204)

    @router.get("/search")
    async def search(
        q: str = "", limit: int = 20, _: Dict[str, Any] = Depends(require_user)
    ) -> Any:
        return {"query": q, "results": db.search(q, max(1, min(limit, 50)))}

    return router
