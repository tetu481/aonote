from __future__ import annotations

import json
import sqlite3
from html import escape
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from .config import Settings
from .db import Database
from .security import now_ts, random_token, token_hash, verify_password, verify_s256


SCOPE_DETAILS = (
    ("notes:read", "閲覧", "ノートの一覧とMarkdown本文を読み取ります。"),
    ("notes:search", "検索", "SQLite全文検索でノートを検索します。"),
    ("notes:write", "書き込み", "ノートの作成・更新・削除を行います。"),
)
SCOPES = {scope for scope, _, _ in SCOPE_DETAILS}
DEFAULT_SCOPE = " ".join(scope for scope, _, _ in SCOPE_DETAILS)


class ClientRegistration(BaseModel):
    redirect_uris: list[str] = Field(min_length=1)
    client_name: str = "aonote MCP client"
    token_endpoint_auth_method: str = "none"
    grant_types: list[str] = ["authorization_code", "refresh_token"]
    response_types: list[str] = ["code"]


def _validate_redirect(uri: str) -> bool:
    parsed = urlparse(uri)
    if parsed.scheme == "https" and parsed.netloc:
        return True
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}


def _client(db: Database, client_id: str) -> Optional[sqlite3.Row]:
    with db.connect() as connection:
        return connection.execute(
            "SELECT * FROM oauth_clients WHERE client_id = ?", (client_id,)
        ).fetchone()


def _allowed_redirect(client: sqlite3.Row, redirect_uri: str) -> bool:
    return redirect_uri in json.loads(client["redirect_uris"])


def _scope_string(scope: str) -> str:
    requested = {part for part in scope.split() if part}
    if not requested:
        requested = set(SCOPES)
    if not requested.issubset(SCOPES):
        raise HTTPException(status_code=400, detail="invalid_scope")
    return " ".join(item for item, _, _ in SCOPE_DETAILS if item in requested)


def _consent_html(
    settings: Settings,
    client_name: str,
    values: Dict[str, str],
    error: str = "",
) -> str:
    hidden = "".join(
        f'<input type="hidden" name="{escape(key)}" value="{escape(value)}">'
        for key, value in values.items()
        if key not in {"scope", "actor_name"}
    )
    requested_scopes = set(values.get("requested_scope", values.get("scope", "")).split())
    selected_scopes = set(values.get("scope", "").split())
    scope_items = "".join(
        f'''<label class="scope-option">
<input type="checkbox" name="scope" value="{escape(scope)}"{" checked" if scope in selected_scopes else ""}>
<span class="scope-copy"><strong>{escape(label)}</strong><code>{escape(scope)}</code><small>{escape(description)}</small></span>
</label>'''
        for scope, label, description in SCOPE_DETAILS
        if scope in requested_scopes
    )
    error_html = f'<p class="error">{escape(error)}</p>' if error else ""
    return f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>aonoteへの接続</title><style>
:root{{font-family:Inter,'Noto Sans JP',sans-serif;color:#14233f;background:#edf6ff}}
*{{box-sizing:border-box}}body{{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}}
main{{width:min(440px,100%);background:white;border:1px solid #cddff2;border-radius:18px;padding:32px;box-shadow:0 18px 55px #315c8d1a}}
.brand{{display:flex;gap:10px;align-items:center;font-weight:750;font-size:19px}}.mark{{width:29px;height:26px;fill:none;stroke:#1768dc;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}}
h1{{font-size:25px;line-height:1.35;margin:28px 0 8px}}p{{color:#566984;line-height:1.65}}
.scope-list{{display:grid;gap:10px;margin-top:18px}}.scope-option{{display:flex;gap:12px;align-items:flex-start;margin:0;border:1px solid #d5e4f3;border-radius:12px;padding:14px;background:#f8fbff;cursor:pointer;transition:.15s ease}}
.scope-option:hover{{border-color:#8eb7e7;background:#f2f8ff}}.scope-option:has(input:checked){{border-color:#8ab7eb;background:#edf6ff}}.scope-option input{{width:18px;height:18px;margin:2px 0 0;accent-color:#1768dc;flex:0 0 auto}}
.scope-copy{{display:grid;grid-template-columns:auto 1fr;gap:3px 9px;min-width:0}}.scope-copy strong{{font-size:14px;color:#203956}}.scope-copy code{{align-self:center;color:#57708c;font-size:11px}}.scope-copy small{{grid-column:1/-1;color:#637993;line-height:1.45}}
label{{display:block;font-size:13px;font-weight:650;margin:20px 0 7px}}input[type=text],input[type=password]{{width:100%;border:1px solid #b9cee5;border-radius:9px;padding:12px;font:inherit;outline:none}}input[type=text]:focus,input[type=password]:focus{{border-color:#1768dc;box-shadow:0 0 0 3px #1768dc1a}}
button{{width:100%;margin-top:22px;border:0;border-radius:9px;background:#1768dc;color:white;padding:12px;font:700 14px inherit;cursor:pointer}}.error{{color:#b3261e;background:#fff0ef;padding:10px;border-radius:8px}}
</style></head><body><main><div class="brand"><svg class="mark" viewBox="0 0 32 28" aria-hidden="true"><path d="M2.5 3.5c4-1.4 8.2-.9 13.5 2.1v18.6c-4.7-2.8-9-3.4-13.5-1.8V3.5Z"></path><path d="M29.5 3.5c-4-1.4-8.2-.9-13.5 2.1v18.6c4.7-2.8 9-3.4 13.5-1.8V3.5Z"></path></svg>aonote</div>
<h1>{escape(client_name)} を接続</h1><p>このクライアントに許可する権限を選択してください。</p>{error_html}
<form method="post" action="/oauth/authorize">{hidden}<div class="scope-list">{scope_items}</div>
<label for="actor_name">表示名</label>
<input id="actor_name" name="actor_name" type="text" maxlength="80" value="{escape(values.get('actor_name', ''))}" placeholder="例：自分、編集アシスタント" autocomplete="nickname" required autofocus>
<label for="password">aonoteの管理パスワード</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">接続を許可</button></form></main></body></html>"""


def create_oauth_router(settings: Settings, db: Database) -> APIRouter:
    router = APIRouter()

    @router.get("/.well-known/oauth-protected-resource")
    @router.get("/.well-known/oauth-protected-resource/mcp")
    async def protected_resource_metadata() -> Dict[str, Any]:
        return {
            "resource": settings.mcp_resource,
            "authorization_servers": [settings.base_url],
            "scopes_supported": sorted(SCOPES),
            "resource_documentation": f"{settings.base_url}/docs#mcp",
            "bearer_methods_supported": ["header"],
        }

    @router.get("/.well-known/oauth-authorization-server")
    async def authorization_server_metadata() -> Dict[str, Any]:
        return {
            "issuer": settings.base_url,
            "authorization_endpoint": f"{settings.base_url}/oauth/authorize",
            "token_endpoint": f"{settings.base_url}/oauth/token",
            "registration_endpoint": f"{settings.base_url}/oauth/register",
            "revocation_endpoint": f"{settings.base_url}/oauth/revoke",
            "scopes_supported": sorted(SCOPES),
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
            "service_documentation": f"{settings.base_url}/docs#mcp",
        }

    @router.post("/oauth/register", status_code=201)
    async def register_client(payload: ClientRegistration) -> Dict[str, Any]:
        if payload.token_endpoint_auth_method != "none":
            raise HTTPException(status_code=400, detail="Only public PKCE clients are supported")
        if any(not _validate_redirect(uri) for uri in payload.redirect_uris):
            raise HTTPException(status_code=400, detail="invalid_redirect_uri")
        client_id = random_token(24)
        with db.connect() as connection:
            connection.execute(
                "INSERT INTO oauth_clients VALUES (?, ?, ?, ?)",
                (client_id, payload.client_name[:120], json.dumps(payload.redirect_uris), now_ts()),
            )
        return {
            "client_id": client_id,
            "client_name": payload.client_name,
            "redirect_uris": payload.redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }

    def validate_authorization(
        client_id: str,
        redirect_uri: str,
        response_type: str,
        scope: str,
        resource: str,
        code_challenge: str,
        code_challenge_method: str,
    ) -> tuple[sqlite3.Row, str]:
        client = _client(db, client_id)
        if not client or not _allowed_redirect(client, redirect_uri):
            raise HTTPException(status_code=400, detail="invalid_client")
        if response_type != "code":
            raise HTTPException(status_code=400, detail="unsupported_response_type")
        if resource != settings.mcp_resource:
            raise HTTPException(status_code=400, detail="invalid_target")
        if code_challenge_method != "S256" or not code_challenge:
            raise HTTPException(status_code=400, detail="PKCE S256 is required")
        return client, _scope_string(scope)

    @router.get("/oauth/authorize", response_class=HTMLResponse)
    async def authorize_page(
        client_id: str,
        redirect_uri: str,
        response_type: str = "code",
        scope: str = DEFAULT_SCOPE,
        state: str = "",
        resource: str = "",
        code_challenge: str = "",
        code_challenge_method: str = "S256",
    ) -> HTMLResponse:
        client, normalized_scope = validate_authorization(
            client_id, redirect_uri, response_type, scope, resource, code_challenge, code_challenge_method
        )
        values = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": response_type,
            "scope": normalized_scope,
            "requested_scope": normalized_scope,
            "state": state,
            "resource": resource,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
            "actor_name": "",
        }
        return HTMLResponse(_consent_html(settings, client["client_name"], values))

    @router.post("/oauth/authorize", response_class=HTMLResponse)
    async def authorize_submit(
        client_id: str = Form(...),
        redirect_uri: str = Form(...),
        response_type: str = Form("code"),
        scope: list[str] = Form(default=[]),
        requested_scope: str = Form(""),
        state: str = Form(""),
        resource: str = Form(""),
        code_challenge: str = Form(...),
        code_challenge_method: str = Form("S256"),
        actor_name: str = Form(""),
        password: str = Form(...),
    ) -> HTMLResponse:
        selected_scope = " ".join(scope)
        original_scope = requested_scope or selected_scope or DEFAULT_SCOPE
        client, normalized_requested_scope = validate_authorization(
            client_id, redirect_uri, response_type, original_scope, resource, code_challenge, code_challenge_method
        )
        values = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": response_type,
            "scope": "",
            "requested_scope": normalized_requested_scope,
            "state": state,
            "resource": resource,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
            "actor_name": actor_name,
        }
        actor_name = actor_name.strip()
        values["actor_name"] = actor_name
        if not actor_name:
            return HTMLResponse(
                _consent_html(settings, client["client_name"], values, "表示名を入力してください。"),
                status_code=400,
            )
        if len(actor_name) > 80:
            return HTMLResponse(
                _consent_html(settings, client["client_name"], values, "表示名は80文字以内で入力してください。"),
                status_code=400,
            )
        if not selected_scope:
            return HTMLResponse(
                _consent_html(settings, client["client_name"], values, "少なくとも1つの権限を選択してください。"),
                status_code=400,
            )
        normalized_scope = _scope_string(selected_scope)
        if not set(normalized_scope.split()).issubset(set(normalized_requested_scope.split())):
            raise HTTPException(status_code=400, detail="invalid_scope")
        values["scope"] = normalized_scope
        if not verify_password(password, settings.admin_password):
            return HTMLResponse(
                _consent_html(settings, client["client_name"], values, "パスワードが正しくありません。"),
                status_code=401,
            )
        code = random_token()
        with db.connect() as connection:
            connection.execute(
                """INSERT INTO oauth_codes
                   (code_hash, client_id, redirect_uri, scope, resource,
                    code_challenge, expires_at, actor_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    token_hash(code), client_id, redirect_uri, normalized_scope,
                    resource, code_challenge, now_ts() + 300, actor_name,
                ),
            )
        query = {"code": code}
        if state:
            query["state"] = state
        return RedirectResponse(f"{redirect_uri}?{urlencode(query)}", status_code=303)

    @router.post("/oauth/token")
    async def issue_token(
        grant_type: str = Form(...),
        client_id: str = Form(...),
        code: str = Form(""),
        redirect_uri: str = Form(""),
        code_verifier: str = Form(""),
        refresh_token: str = Form(""),
        resource: str = Form(""),
    ) -> JSONResponse:
        client = _client(db, client_id)
        if not client:
            return JSONResponse({"error": "invalid_client"}, status_code=401)
        scope = ""
        actor_name = ""
        if grant_type == "authorization_code":
            with db.connect() as connection:
                row = connection.execute(
                    "SELECT * FROM oauth_codes WHERE code_hash = ?", (token_hash(code),)
                ).fetchone()
                if not row or row["expires_at"] <= now_ts():
                    return JSONResponse({"error": "invalid_grant"}, status_code=400)
                if (
                    row["client_id"] != client_id
                    or row["redirect_uri"] != redirect_uri
                    or row["resource"] != resource
                    or not verify_s256(code_verifier, row["code_challenge"])
                ):
                    return JSONResponse({"error": "invalid_grant"}, status_code=400)
                scope = row["scope"]
                actor_name = row["actor_name"]
                connection.execute("DELETE FROM oauth_codes WHERE code_hash = ?", (token_hash(code),))
        elif grant_type == "refresh_token":
            with db.connect() as connection:
                row = connection.execute(
                    """SELECT * FROM oauth_tokens WHERE token_hash = ? AND token_kind = 'refresh'""",
                    (token_hash(refresh_token),),
                ).fetchone()
                if (
                    not row or row["expires_at"] <= now_ts()
                    or row["client_id"] != client_id or row["resource"] != resource
                ):
                    return JSONResponse({"error": "invalid_grant"}, status_code=400)
                scope = row["scope"]
                actor_name = row["actor_name"]
                connection.execute("DELETE FROM oauth_tokens WHERE token_hash = ?", (token_hash(refresh_token),))
        else:
            return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)

        access = random_token()
        refresh = random_token()
        with db.connect() as connection:
            connection.executemany(
                """INSERT INTO oauth_tokens
                   (token_hash, token_kind, client_id, scope, resource, expires_at, actor_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [
                    (token_hash(access), "access", client_id, scope, resource, now_ts() + settings.access_token_ttl, actor_name),
                    (token_hash(refresh), "refresh", client_id, scope, resource, now_ts() + settings.refresh_token_ttl, actor_name),
                ],
            )
        return JSONResponse(
            {
                "access_token": access,
                "token_type": "Bearer",
                "expires_in": settings.access_token_ttl,
                "refresh_token": refresh,
                "scope": scope,
            },
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )

    @router.post("/oauth/revoke", status_code=200)
    async def revoke_token(token: str = Form(...)) -> Dict[str, bool]:
        with db.connect() as connection:
            connection.execute("DELETE FROM oauth_tokens WHERE token_hash = ?", (token_hash(token),))
        return {"revoked": True}

    return router


def validate_oauth_token(
    db: Database, token: str, resource: str, required_scope: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    with db.connect() as connection:
        row = connection.execute(
            """SELECT t.*, c.client_name FROM oauth_tokens t
               JOIN oauth_clients c ON c.client_id = t.client_id
               WHERE t.token_hash = ? AND t.token_kind = 'access'""",
            (token_hash(token),),
        ).fetchone()
        if not row or row["expires_at"] <= now_ts() or row["resource"] != resource:
            return None
        scopes = set(row["scope"].split())
        if required_scope and required_scope not in scopes:
            return None
        return {
            "client_id": row["client_id"],
            "client_name": row["client_name"],
            "actor_name": row["actor_name"] or row["client_name"],
            "scopes": scopes,
            "resource": row["resource"],
        }
