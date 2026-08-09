import base64
import hashlib
import sqlite3
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from aonote.config import Settings
from aonote.db import Database
from aonote.main import create_app


def make_client(tmp_path: Path, bypass: bool = True) -> httpx.AsyncClient:
    settings = Settings(
        database_path=tmp_path / "test.sqlite3",
        base_url="http://testserver",
        admin_password="test-password",
        dev_bypass_auth=bypass,
    )
    app = create_app(settings)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def pkce(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


async def oauth_token(
    client: httpx.AsyncClient,
    scope: str = "notes:read notes:search notes:write",
    requested_scope: str = "",
    actor_name: str = "テスト担当",
) -> str:
    redirect_uri = "https://chatgpt.com/connector/oauth/test-callback"
    registration = await client.post(
        "/oauth/register",
        json={"client_name": "Test ChatGPT", "redirect_uris": [redirect_uri]},
    )
    assert registration.status_code == 201
    client_id = registration.json()["client_id"]
    verifier = "test-verifier-with-more-than-forty-three-characters-123456"
    authorization = await client.post(
        "/oauth/authorize",
        data={
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope,
            "requested_scope": requested_scope or scope,
            "state": "state-value",
            "resource": "http://testserver/mcp",
            "code_challenge": pkce(verifier),
            "code_challenge_method": "S256",
            "actor_name": actor_name,
            "password": "test-password",
        },
        follow_redirects=False,
    )
    assert authorization.status_code == 303
    query = parse_qs(urlparse(authorization.headers["location"]).query)
    assert query["state"] == ["state-value"]
    exchange = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": query["code"][0],
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
            "resource": "http://testserver/mcp",
        },
    )
    assert exchange.status_code == 200
    return exchange.json()["access_token"]


@pytest.mark.anyio
async def test_markdown_crud_search_and_version_conflict(tmp_path: Path):
    async with make_client(tmp_path) as client:
        tree = await client.get("/api/tree")
        assert tree.status_code == 200
        inbox_id = next(folder["id"] for folder in tree.json() if folder["name"] == "Inbox")

        created = await client.post(
            "/api/notes",
            json={
                "filename": "検索テスト.md",
                "folder_id": inbox_id,
                "content": "# 検索テスト\n\n青い鳥とSQLiteの全文検索について。",
            },
        )
        assert created.status_code == 201
        note = created.json()
        assert note["created_by"] == "管理者"
        assert note["created_via"] is None
        assert note["updated_by"] == "管理者"
        assert note["updated_via"] is None
        assert note["created_at"] <= note["updated_at"]

        response = await client.get("/api/search", params={"q": "全文検索"})
        results = response.json()["results"]
        assert any(result["id"] == note["id"] for result in results)

        updated = await client.patch(
            f"/api/notes/{note['id']}",
            json={"content": note["content"] + "\n\n更新しました。", "version": note["version"]},
        )
        assert updated.status_code == 200
        assert updated.json()["version"] == 2
        assert updated.json()["updated_by"] == "管理者"

        conflict = await client.patch(
            f"/api/notes/{note['id']}",
            json={"content": "古い編集", "version": 1},
        )
        assert conflict.status_code == 409


@pytest.mark.anyio
async def test_web_authentication(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        assert (await client.get("/api/tree")).status_code == 401
        assert (await client.post("/api/session", json={"password": "wrong"})).status_code == 401
        assert (await client.post("/api/session", json={"password": "test-password"})).status_code == 200
        assert (await client.get("/api/tree")).status_code == 200


@pytest.mark.anyio
async def test_oauth_discovery_pkce_and_mcp_tools(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        metadata = (await client.get("/.well-known/oauth-protected-resource")).json()
        assert metadata["resource"] == "http://testserver/mcp"
        discovery = (await client.get("/.well-known/oauth-authorization-server")).json()
        assert discovery["code_challenge_methods_supported"] == ["S256"]

        unauthorized = await client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}
        )
        assert unauthorized.status_code == 401
        assert "resource_metadata" in unauthorized.headers["www-authenticate"]

        access_token = await oauth_token(client)
        headers = {"Authorization": f"Bearer {access_token}"}
        initialized = await client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        assert initialized.status_code == 200
        assert initialized.json()["result"]["serverInfo"]["name"] == "aonote"

        tool_response = await client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        tools = tool_response.json()["result"]["tools"]
        assert {tool["name"] for tool in tools} >= {
            "search_notes", "get_note", "list_folders", "create_note", "update_note",
            "rename_note", "move_note",
        }

        search_response = await client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "search_notes", "arguments": {"query": "OAuth"}},
            },
        )
        search = search_response.json()["result"]
        assert search["isError"] is False
        assert search["structuredContent"]["items"]


@pytest.mark.anyio
async def test_oauth_consent_scope_checkboxes(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        redirect_uri = "https://chatgpt.com/connector/oauth/test-callback"
        registration = await client.post(
            "/oauth/register",
            json={"client_name": "Scope Test", "redirect_uris": [redirect_uri]},
        )
        client_id = registration.json()["client_id"]
        verifier = "test-verifier-with-more-than-forty-three-characters-123456"
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "notes:read notes:search notes:write",
            "state": "state-value",
            "resource": "http://testserver/mcp",
            "code_challenge": pkce(verifier),
            "code_challenge_method": "S256",
        }

        consent = await client.get("/oauth/authorize", params=params)
        assert consent.status_code == 200
        assert consent.text.count('type="checkbox"') == 3
        assert 'value="notes:read" checked' in consent.text
        assert 'value="notes:search" checked' in consent.text
        assert 'value="notes:write" checked' in consent.text
        assert 'name="actor_name"' in consent.text
        assert 'maxlength="80"' in consent.text

        missing_name = await client.post(
            "/oauth/authorize",
            data={
                **params,
                "requested_scope": params["scope"],
                "scope": params["scope"],
                "actor_name": "",
                "password": "test-password",
            },
        )
        assert missing_name.status_code == 400
        assert "表示名を入力してください。" in missing_name.text

        no_scopes = await client.post(
            "/oauth/authorize",
            data={
                **params,
                "requested_scope": params["scope"],
                "scope": [],
                "actor_name": "テスト担当",
                "password": "test-password",
            },
        )
        assert no_scopes.status_code == 400
        assert "少なくとも1つの権限を選択してください。" in no_scopes.text


@pytest.mark.anyio
async def test_mcp_write_scope_is_enforced(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        access_token = await oauth_token(
            client,
            "notes:read notes:search",
            requested_scope="notes:read notes:search notes:write",
        )
        response = await client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "create_note",
                    "arguments": {"filename": "拒否.md", "content": "# 拒否"},
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["result"]["isError"] is True


@pytest.mark.anyio
async def test_nested_folders_relocation_and_depth_limit(tmp_path: Path):
    async with make_client(tmp_path) as client:
        root = (await client.post("/api/folders", json={"name": "第一階層"})).json()
        second = (await client.post(
            "/api/folders", json={"name": "第二階層", "parent_id": root["id"]}
        )).json()
        third = (await client.post(
            "/api/folders", json={"name": "第三階層", "parent_id": second["id"]}
        )).json()
        too_deep = await client.post(
            "/api/folders", json={"name": "第四階層", "parent_id": third["id"]}
        )
        assert too_deep.status_code == 400
        assert "最大3階層" in too_deep.json()["detail"]

        tree = (await client.get("/api/tree")).json()
        root_node = next(folder for folder in tree if folder["id"] == root["id"])
        assert root_node["folders"][0]["id"] == second["id"]
        assert root_node["folders"][0]["folders"][0]["id"] == third["id"]

        created = (await client.post(
            "/api/notes", json={"filename": "移動前.md", "content": "# 移動対象"}
        )).json()
        relocated = await client.patch(
            f"/api/notes/{created['id']}/location",
            json={"filename": "移動後.md", "folder_id": third["id"], "version": created["version"]},
        )
        assert relocated.status_code == 200
        moved = relocated.json()
        assert moved["filename"] == "移動後.md"
        assert moved["folder_id"] == third["id"]
        assert [folder["name"] for folder in moved["folder_path"]] == ["第一階層", "第二階層", "第三階層"]
        assert moved["updated_by"] == "管理者"

        renamed_folder = await client.patch(
            f"/api/folders/{second['id']}", json={"name": "第二階層・改名"}
        )
        assert renamed_folder.status_code == 200
        assert renamed_folder.json()["name"] == "第二階層・改名"
        after_rename = (await client.get(f"/api/notes/{created['id']}")).json()
        assert [folder["name"] for folder in after_rename["folder_path"]] == [
            "第一階層", "第二階層・改名", "第三階層"
        ]

        deleted = await client.delete(f"/api/folders/{root['id']}")
        assert deleted.status_code == 204
        preserved = (await client.get(f"/api/notes/{created['id']}")).json()
        assert preserved["content"] == "# 移動対象"
        assert preserved["folder_id"] is None
        assert preserved["folder_path"] == []
        assert preserved["version"] == moved["version"]
        after_delete = (await client.get("/api/tree")).json()
        assert not any(folder["id"] == root["id"] for folder in after_delete)
        unfiled = next(folder for folder in after_delete if folder["id"] == "unfiled")
        assert any(note["id"] == created["id"] for note in unfiled["notes"])

        assert (await client.patch("/api/folders/unfiled", json={"name": "変更不可"})).status_code == 404
        assert (await client.delete("/api/folders/unfiled")).status_code == 404


@pytest.mark.anyio
async def test_mcp_actor_rename_and_move(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        access_token = await oauth_token(client, actor_name="ノート係")
        headers = {"Authorization": f"Bearer {access_token}"}
        folder_response = await client.post(
            "/api/folders", headers=headers, json={"name": "AI整理先"}
        )
        assert folder_response.status_code == 201
        folder = folder_response.json()

        async def tool(name: str, arguments: dict):
            response = await client.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0", "id": name, "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
            )
            assert response.status_code == 200
            result = response.json()["result"]
            assert result["isError"] is False, result
            return result["structuredContent"]

        created = await tool("create_note", {"filename": "AI作成.md", "content": "# AI作成"})
        assert created["created_by"] == "ノート係"
        assert created["created_via"] == "Test ChatGPT"

        renamed = await tool("rename_note", {
            "note_id": created["id"], "filename": "AI改名.md", "version": created["version"],
        })
        assert renamed["filename"] == "AI改名.md"
        assert renamed["updated_by"] == "ノート係"
        assert renamed["updated_via"] == "Test ChatGPT"

        moved = await tool("move_note", {
            "note_id": renamed["id"], "folder_id": folder["id"], "version": renamed["version"],
        })
        assert moved["folder_id"] == folder["id"]
        assert moved["folder_name"] == "AI整理先"

        folders = await tool("list_folders", {})
        assert any(item["id"] == folder["id"] for item in folders["items"])


def test_existing_database_is_migrated_without_losing_notes(tmp_path: Path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE folders (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
                position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE notes (
                id TEXT PRIMARY KEY, folder_id TEXT, filename TEXT NOT NULL,
                title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, UNIQUE(folder_id, filename)
            );
            CREATE TABLE note_revisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL,
                title TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE oauth_codes (
                code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL,
                redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
                code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE oauth_tokens (
                token_hash TEXT PRIMARY KEY, token_kind TEXT NOT NULL,
                client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            INSERT INTO folders VALUES ('legacy-folder', '既存', NULL, 0, 1, 1);
            INSERT INTO notes VALUES (
                'legacy-note', 'legacy-folder', '既存.md', '既存', '# 既存\n\n残す本文', 4, 1, 2
            );
            """
        )

    database = Database(path)
    database.initialize()
    note = database.get_note("legacy-note")
    assert note is not None
    assert note["content"] == "# 既存\n\n残す本文"
    assert note["version"] == 4
    assert note["created_by"] == "管理者"
    assert note["updated_by"] == "管理者"
    with database.connect() as connection:
        assert "actor_name" in {row["name"] for row in connection.execute("PRAGMA table_info(oauth_tokens)")}
