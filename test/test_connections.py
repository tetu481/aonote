import asyncio
import base64
import hashlib
import sqlite3
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from aonote.application import create_app
from aonote.config import Settings
from aonote.db import Database
from aonote.oauth import validate_oauth_token
from aonote.security import now_ts, token_hash


ALL_SCOPES = ["notes:read", "notes:search", "notes:write"]
MANAGEMENT = {"X-Aonote-Request": "connections", "Origin": "http://testserver"}
RESOURCE = "http://testserver/mcp"
CALLBACK = "https://client.example/callback"
VERIFIER = "a-valid-test-pkce-verifier-with-at-least-43-characters"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(
        database_path=tmp_path / "connections.sqlite3", base_url="http://testserver",
        admin_password="test-password", dev_bypass_auth=False,
    ))


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        yield client


async def login(client):
    assert (await client.post("/api/session", json={"password": "test-password"})).status_code == 200


async def authorize(client, *, client_id=None, actor="編集アシスタント", scopes=None, exchange=True):
    if client_id is None:
        result = await client.post("/oauth/register", json={"client_name": "Test AI", "redirect_uris": [CALLBACK]})
        assert result.status_code == 201
        client_id = result.json()["client_id"]
    scope = " ".join(scopes or ALL_SCOPES)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
    response = await client.post("/oauth/authorize", data={
        "client_id": client_id, "redirect_uri": CALLBACK, "scope": scope,
        "requested_scope": scope, "resource": RESOURCE, "actor_name": actor,
        "password": "test-password", "code_challenge": challenge,
    })
    assert response.status_code == 303
    data = {
        "grant_type": "authorization_code", "client_id": client_id,
        "code": parse_qs(urlparse(response.headers["location"]).query)["code"][0],
        "redirect_uri": CALLBACK, "code_verifier": VERIFIER, "resource": RESOURCE,
    }
    if not exchange:
        return data
    result = await client.post("/oauth/token", data=data)
    assert result.status_code == 200
    return {"client_id": client_id, **result.json()}


async def refresh(client, tokens):
    return await client.post("/oauth/token", data={
        "grant_type": "refresh_token", "client_id": tokens["client_id"],
        "refresh_token": tokens["refresh_token"], "resource": RESOURCE,
    })


def bearer(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def rpc(name, arguments=None):
    return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}


async def edit(client, row, **changes):
    return await client.patch(f"/api/connections/{row['id']}", headers=MANAGEMENT, json={
        "actor_name": row["actor_name"], "scopes": row["scopes"], "version": row["version"], **changes,
    })


@pytest.mark.anyio
async def test_listing_excludes_unapproved_clients_and_secrets(client, app):
    await client.post("/oauth/register", json={"client_name": "Unapproved", "redirect_uris": [CALLBACK]})
    tokens = await authorize(client)
    await login(client)
    response = await client.get("/api/connections")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert len(response.json()) == 1
    row = response.json()[0]
    assert row["status"] == "active"
    assert row["actor_name"] == "編集アシスタント"
    assert row["client_name"] == "Test AI"
    assert row["scopes"] == row["approved_scopes"] == ALL_SCOPES
    assert row["created_at"] and row["last_used_at"] is None
    assert not row["legacy"]
    for secret in (tokens["access_token"], tokens["refresh_token"], token_hash(tokens["access_token"]), "token_hash", "code_hash"):
        assert secret not in response.text
    assert "test-password" not in response.text
    client.cookies.clear()
    assert (await client.get("/api/tree", headers=bearer(tokens))).status_code == 200
    await login(client)
    used = (await client.get("/api/connections")).json()[0]
    assert used["last_used_at"] is not None
    assert used["version"] == row["version"]  # Activity does not conflict with editing.


@pytest.mark.anyio
@pytest.mark.parametrize("authorized_ai", [False, True])
async def test_only_browser_admin_can_manage_connections(client, authorized_ai):
    tokens = await authorize(client)
    headers = {**MANAGEMENT, **(bearer(tokens) if authorized_ai else {})}
    for method, path, kwargs in (
        ("GET", "/api/connections", {}),
        ("PATCH", "/api/connections/unknown", {"json": {"actor_name": "attacker", "scopes": ALL_SCOPES, "version": 1}}),
        ("DELETE", "/api/connections/unknown", {}),
    ):
        response = await client.request(method, path, headers=headers, **kwargs)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.anyio
@pytest.mark.parametrize("extra", [
    {}, {"Origin": "http://testserver"},
    {"X-Aonote-Request": "connections", "Origin": "https://evil.test"},
    {"X-Aonote-Request": "connections", "Origin": "http://untrusted.testserver"},
    {"X-Aonote-Request": "connections", "Origin": "null"},
    {"X-Aonote-Request": "connections", "Sec-Fetch-Site": "same-site"},
    {"X-Aonote-Request": "connections", "Sec-Fetch-Site": "cross-site"},
])
async def test_csrf_management_requests_rejected(client, extra):
    await authorize(client)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    path = f"/api/connections/{row['id']}"
    assert (await client.delete(path, headers=extra)).status_code == 403
    assert (await client.patch(path, headers=extra, json={"actor_name": "bad", "scopes": ALL_SCOPES, "version": 1})).status_code == 403
    assert (await client.get("/api/connections")).json()[0] == row


@pytest.mark.anyio
async def test_name_and_permission_updates_apply_to_existing_access_and_refresh(client, app):
    tokens = await authorize(client)
    initial = await client.post("/api/notes", headers=bearer(tokens), json={"filename": "AI.md", "content": "# Before"})
    assert initial.status_code == 201
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    updated = await edit(client, row, actor_name="  読書係  ", scopes=["notes:read"])
    assert updated.status_code == 200
    assert updated.json()["actor_name"] == "読書係"
    assert app.state.db.get_note(initial.json()["id"])["created_by"] == "編集アシスタント"
    client.cookies.clear()
    assert (await client.get("/api/tree", headers=bearer(tokens))).status_code == 200
    assert (await client.get("/api/search?q=test", headers=bearer(tokens))).status_code == 403
    assert (await client.post("/api/notes", headers=bearer(tokens), json={"filename": "denied.md"})).status_code == 403
    denied = await client.post("/mcp", headers=bearer(tokens), json=rpc("create_note", {"filename": "denied.md", "content": "# Denied"}))
    assert denied.json()["result"]["isError"]
    assert "OAuth scope required: notes:write" in denied.json()["result"]["content"][0]["text"]
    renewed = await refresh(client, tokens)
    assert renewed.status_code == 200
    assert renewed.json()["scope"] == "notes:read"
    await login(client)
    restored = await edit(client, updated.json(), actor_name="新しい編集係", scopes=ALL_SCOPES)
    assert restored.status_code == 200
    # Fresh read-only access tokens stay bounded until their next refresh.
    client.cookies.clear()
    read_only = {"client_id": tokens["client_id"], **renewed.json()}
    assert (await client.post("/api/notes", headers=bearer(read_only), json={"filename": "denied.md"})).status_code == 403
    next_tokens = await refresh(client, read_only)
    assert set(next_tokens.json()["scope"].split()) == set(ALL_SCOPES)
    written = await client.post("/api/notes", headers=bearer(next_tokens.json()), json={"filename": "new.md"})
    assert written.status_code == 201
    assert written.json()["created_by"] == "新しい編集係"
    assert written.json()["created_via"] == "Test AI"
    assert app.state.db.get_note(initial.json()["id"])["created_by"] == "編集アシスタント"


@pytest.mark.anyio
@pytest.mark.parametrize("changes, expected", [
    ({"scopes": []}, 422), ({"scopes": ["admin"]}, 422),
    ({"scopes": ALL_SCOPES}, 400), ({"actor_name": " "}, 422),
    ({"actor_name": "a" * 81}, 422), ({"actor_name": "a\nb"}, 422),
    ({"actor_name": None}, 422), ({"version": True}, 422),
    ({"version": 42}, 409), ({"client_name": "Forged"}, 422),
    ({"resource": "https://evil.test"}, 422),
])
async def test_invalid_edits_do_not_mutate_connection(client, changes, expected):
    await authorize(client, scopes=["notes:read"])
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    assert (await edit(client, row, **changes)).status_code == expected
    assert (await client.get("/api/connections")).json()[0] == row


@pytest.mark.anyio
async def test_disconnect_revokes_all_rotations_but_not_other_grants_same_client(client, app):
    first = await authorize(client)
    second = await authorize(client, client_id=first["client_id"])
    rotated = await refresh(client, first)
    await login(client)
    rows = (await client.get("/api/connections")).json()
    assert len(rows) == 2
    with app.state.db.connect() as connection:
        target_id = connection.execute("SELECT connection_id FROM oauth_tokens WHERE token_hash = ?", (token_hash(first["access_token"]),)).fetchone()[0]
    target = next(row for row in rows if row["id"] == target_id)
    before_notes = app.state.db.list_recent(50)
    assert (await client.delete(f"/api/connections/{target_id}", headers=MANAGEMENT)).status_code == 204
    assert (await client.delete(f"/api/connections/{target_id}", headers=MANAGEMENT)).status_code == 204
    assert (await edit(client, target)).status_code == 409
    assert app.state.db.list_recent(50) == before_notes
    client.cookies.clear()
    for token in (first, rotated.json()):
        assert (await client.get("/api/tree", headers=bearer(token))).status_code == 401
        assert (await client.post("/mcp", headers=bearer(token), json=rpc("list_notes"))).status_code == 401
    assert (await refresh(client, {"client_id": first["client_id"], **rotated.json()})).status_code == 400
    assert (await refresh(client, first)).status_code == 400
    assert (await client.get("/api/tree", headers=bearer(second))).status_code == 200
    assert (await refresh(client, second)).status_code == 200
    app.state.db.initialize()
    assert (await client.get("/api/tree", headers=bearer(first))).status_code == 401


@pytest.mark.anyio
async def test_pending_code_can_be_revoked_before_exchange(client):
    data = await authorize(client, exchange=False)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    assert row["status"] == "pending"
    assert (await client.delete(f"/api/connections/{row['id']}", headers=MANAGEMENT)).status_code == 204
    assert (await client.post("/oauth/token", data=data)).json() == {"error": "invalid_grant"}


@pytest.mark.anyio
async def test_edit_pending_code_and_expired_connections(client, app):
    data = await authorize(client, exchange=False)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    assert (await edit(client, row, actor_name="Changed", scopes=["notes:read"])).status_code == 200
    tokens = (await client.post("/oauth/token", data=data)).json()
    assert tokens["scope"] == "notes:read"
    principal = validate_oauth_token(app.state.db, tokens["access_token"], RESOURCE)
    assert principal["actor_name"] == "Changed"
    with app.state.db.connect(write=True) as connection:
        connection.execute("UPDATE oauth_tokens SET expires_at = ?", (now_ts() - 1,))
    assert (await client.get("/api/connections")).json()[0]["status"] == "expired"


@pytest.mark.anyio
@pytest.mark.parametrize("token_kind", ["access_token", "refresh_token"])
async def test_oauth_revoke_also_disconnects_entire_grant(client, token_kind):
    tokens = await authorize(client)
    rotated = (await refresh(client, tokens)).json()
    response = await client.post("/oauth/revoke", data={"token": rotated[token_kind]})
    assert response.status_code == 200
    assert (await client.get("/api/tree", headers=bearer(tokens))).status_code == 401
    assert (await client.get("/api/tree", headers=bearer(rotated))).status_code == 401
    assert (await refresh(client, {"client_id": tokens["client_id"], **rotated})).status_code == 400
    assert (await client.post("/oauth/revoke", data={"token": "unknown"})).status_code == 200


@pytest.mark.anyio
async def test_refresh_and_disconnect_race_cannot_resurrect_tokens(client, app):
    tokens = await authorize(client)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    renewed, revoked = await asyncio.gather(
        refresh(client, tokens), client.delete(f"/api/connections/{row['id']}", headers=MANAGEMENT),
    )
    assert renewed.status_code in (200, 400)
    assert revoked.status_code == 204
    with app.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM oauth_tokens WHERE connection_id = ?", (row["id"],)).fetchone()[0] == 0
    client.cookies.clear()
    assert (await client.get("/api/tree", headers=bearer(tokens))).status_code == 401
    if renewed.status_code == 200:
        assert (await client.get("/api/tree", headers=bearer(renewed.json()))).status_code == 401


@pytest.mark.anyio
async def test_disconnect_rolls_back_if_token_deletion_fails(client, app):
    tokens = await authorize(client)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    with app.state.db.connect(write=True) as connection:
        connection.execute("CREATE TRIGGER fail_revoke BEFORE DELETE ON oauth_tokens BEGIN SELECT RAISE(ABORT, 'test'); END")
    assert (await client.delete(f"/api/connections/{row['id']}", headers=MANAGEMENT)).status_code == 503
    assert (await client.get("/api/connections")).json()[0] == row
    assert validate_oauth_token(app.state.db, tokens["access_token"], RESOURCE)


@pytest.mark.anyio
async def test_stale_edit_and_missing_target(client):
    await authorize(client)
    await login(client)
    row = (await client.get("/api/connections")).json()[0]
    results = await asyncio.gather(edit(client, row, actor_name="A"), edit(client, row, actor_name="B"))
    assert sorted(result.status_code for result in results) == [200, 409]
    missing = {**row, "id": "missing"}
    assert (await edit(client, missing)).status_code == 404
    assert (await client.delete("/api/connections/missing", headers=MANAGEMENT)).status_code == 404


@pytest.mark.anyio
async def test_legacy_migration_preserves_credentials_and_groups_without_scope_escalation(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    # The exact pre-feature OAuth schema, including differently scoped tokens
    # for the same legacy display name and a second actor using the same client.
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, token_kind TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, actor_name TEXT NOT NULL DEFAULT '');
            CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, actor_name TEXT NOT NULL DEFAULT '');
        """)
        connection.execute("INSERT INTO oauth_clients VALUES (?, ?, ?, ?)", ("old", "Legacy AI", '["https://client.example/callback"]', now_ts() - 100))
        for token, kind, actor, scopes in (
            ("read", "access", "A", "notes:read"),
            ("write", "access", "A", "notes:read notes:write"),
            ("refresh", "refresh", "A", "notes:read"),
            ("other", "access", "B", "notes:read"),
        ):
            connection.execute("INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?, ?)", (token_hash(token), kind, "old", scopes, RESOURCE, now_ts() + 3600, actor))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
        connection.execute("INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (token_hash("code"), "old", CALLBACK, "notes:read", RESOURCE, challenge, now_ts() + 300, "A"))
    app = create_app(Settings(database_path=path, base_url="http://testserver", admin_password="test-password", dev_bypass_auth=False))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        await login(client)
        rows = (await client.get("/api/connections")).json()
        assert len(rows) == 2
        assert all(row["legacy"] and row["created_at"] is None for row in rows)
        assert validate_oauth_token(app.state.db, "read", RESOURCE)["scopes"] == {"notes:read"}
        assert validate_oauth_token(app.state.db, "write", RESOURCE)["scopes"] == {"notes:read", "notes:write"}
        Database(path).initialize()
        assert len((await client.get("/api/connections")).json()) == 2
        tokens = await client.post("/oauth/token", data={"grant_type": "authorization_code", "client_id": "old", "code": "code", "code_verifier": VERIFIER, "redirect_uri": CALLBACK, "resource": RESOURCE})
        assert tokens.status_code == 200
        assert tokens.json()["scope"] == "notes:read"
        target = next(row for row in rows if row["actor_name"] == "A")
        assert (await client.delete(f"/api/connections/{target['id']}", headers=MANAGEMENT)).status_code == 204
        for token in ("read", "write", tokens.json()["access_token"]):
            assert validate_oauth_token(app.state.db, token, RESOURCE) is None
        assert validate_oauth_token(app.state.db, "other", RESOURCE)
        assert (await refresh(client, {"client_id": "old", "refresh_token": "refresh"})).status_code == 400
        with app.state.db.connect() as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
