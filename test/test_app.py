import base64
import hashlib
import sqlite3
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from aonote.config import Settings
from aonote.db import (
    PRE_FOLDER_AGENT_SKILL_NOTE,
    PRE_FOLDER_MCP_NOTE,
    SEED_NOTES,
    Database,
)
from aonote.application import create_app


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
        folders = tree.json()
        assert [folder["name"] for folder in folders] == ["ようこそ"]
        assert [note["filename"] for note in folders[0]["notes"]] == [
            "01-ようこそ.md",
            "02-MCP連携.md",
            "03-SQLite全文検索.md",
            "04-Agent Skill.md",
        ]
        sqlite_note = next(note for note in folders[0]["notes"] if note["filename"] == "03-SQLite全文検索.md")
        sqlite_note_response = await client.get(f"/api/notes/{sqlite_note['id']}")
        assert sqlite_note_response.status_code == 200
        assert "Embeddingモデルを使わず" not in sqlite_note_response.json()["content"]
        skill_note = next(note for note in folders[0]["notes"] if note["filename"] == "04-Agent Skill.md")
        skill_note_response = await client.get(f"/api/notes/{skill_note['id']}")
        assert skill_note_response.status_code == 200
        assert "name: aonote-workspace" in skill_note_response.json()["content"]
        assert "`get_note` accepts exactly one of `note_id` or `path`" in skill_note_response.json()["content"]
        assert "`create_folder`" in skill_note_response.json()["content"]
        assert "Missing parent folders are created automatically" in skill_note_response.json()["content"]
        assert "`update_note`" in skill_note_response.json()["content"]
        assert "`delete_note`" in skill_note_response.json()["content"]
        mcp_note = next(note for note in folders[0]["notes"] if note["filename"] == "02-MCP連携.md")
        mcp_note_response = await client.get(f"/api/notes/{mcp_note['id']}")
        assert mcp_note_response.status_code == 200
        assert "Projects/test/note.md" in mcp_note_response.json()["content"]
        assert any(link["filename"] == "01-ようこそ.md" for link in mcp_note_response.json()["backlinks"])
        welcome_note = next(note for note in folders[0]["notes"] if note["filename"] == "01-ようこそ.md")
        welcome_note_response = await client.get(f"/api/notes/{welcome_note['id']}")
        assert welcome_note_response.status_code == 200
        assert welcome_note_response.json()["links"] == [
            {"target": "02-MCP連携", "id": mcp_note["id"]}
        ]
        welcome_id = folders[0]["id"]

        created = await client.post(
            "/api/notes",
            json={
                "filename": "検索テスト.md",
                "folder_id": welcome_id,
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
        assert "create_folder" in initialized.json()["result"]["instructions"]
        assert "workspace path" in initialized.json()["result"]["instructions"]

        tool_response = await client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        tools = tool_response.json()["result"]["tools"]
        assert {tool["name"] for tool in tools} >= {
            "search_notes", "get_note", "list_folders", "create_note", "update_note",
            "create_folder", "rename_note", "move_note",
        }
        get_note_tool = next(tool for tool in tools if tool["name"] == "get_note")
        assert set(get_note_tool["inputSchema"]["properties"]) == {"note_id", "path"}
        assert get_note_tool["inputSchema"]["oneOf"] == [
            {"required": ["note_id"]},
            {"required": ["path"]},
        ]
        create_folder_tool = next(
            tool for tool in tools if tool["name"] == "create_folder"
        )
        assert create_folder_tool["inputSchema"]["required"] == ["name"]
        create_note_tool = next(tool for tool in tools if tool["name"] == "create_note")
        assert set(create_note_tool["inputSchema"]["properties"]) == {
            "filename", "path", "content", "folder_id"
        }
        assert create_note_tool["inputSchema"]["oneOf"] == [
            {"required": ["filename"]},
            {"required": ["path"]},
        ]

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

        path_response = await client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "get_note",
                    "arguments": {"path": "ようこそ/02-MCP連携.md"},
                },
            },
        )
        path_result = path_response.json()["result"]
        assert path_result["isError"] is False
        path_note = path_result["structuredContent"]
        assert path_note["path"] == "ようこそ/02-MCP連携.md"
        assert "# MCP連携のセットアップ" in path_note["content"]

        id_response = await client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "get_note",
                    "arguments": {"note_id": path_note["id"]},
                },
            },
        )
        assert id_response.json()["result"]["structuredContent"]["id"] == path_note["id"]

        both_response = await client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "get_note",
                    "arguments": {
                        "note_id": path_note["id"],
                        "path": path_note["path"],
                    },
                },
            },
        )
        assert both_response.json()["result"]["isError"] is True
        assert "exactly one" in both_response.json()["result"]["content"][0]["text"]


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
        assert '<svg class="mark" viewBox="0 0 32 28" aria-hidden="true">' in consent.text
        assert consent.text.count('<path d="M') == 2

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
        headers = {"Authorization": f"Bearer {access_token}"}
        denied_calls = (
            ("create_folder", {"name": "拒否フォルダ"}),
            ("create_note", {"filename": "拒否.md", "content": "# 拒否"}),
            ("create_note", {"path": "拒否/パス.md", "content": "# 拒否"}),
        )
        for request_id, (tool_name, arguments) in enumerate(denied_calls, start=4):
            response = await client.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments},
                },
            )
            assert response.status_code == 200
            result = response.json()["result"]
            assert result["isError"] is True
            assert "notes:write" in result["content"][0]["text"]
        tree = (await client.get("/api/tree", headers=headers)).json()
        assert [folder["name"] for folder in tree] == ["ようこそ"]


@pytest.mark.anyio
async def test_mcp_folder_and_path_note_creation(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        access_token = await oauth_token(client, actor_name="構成担当")
        headers = {"Authorization": f"Bearer {access_token}"}

        async def call_tool(name: str, arguments: dict, error: bool = False):
            response = await client.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": f"{name}-{len(arguments)}",
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
            )
            assert response.status_code == 200
            result = response.json()["result"]
            assert result["isError"] is error, result
            return result if error else result["structuredContent"]

        root = await call_tool("create_folder", {"name": "MCPルート"})
        child = await call_tool(
            "create_folder", {"name": "子", "parent_id": root["id"]}
        )
        third = await call_tool(
            "create_folder", {"name": "孫", "parent_id": child["id"]}
        )
        assert (root["depth"], child["depth"], third["depth"]) == (1, 2, 3)

        depth_error = await call_tool(
            "create_folder",
            {"name": "第四階層", "parent_id": third["id"]},
            error=True,
        )
        assert "cannot exceed 3" in depth_error["content"][0]["text"]
        duplicate_folder = await call_tool(
            "create_folder", {"name": "MCPルート"}, error=True
        )
        assert "already exists" in duplicate_folder["content"][0]["text"]
        missing_parent = await call_tool(
            "create_folder",
            {"name": "孤立", "parent_id": "missing-folder"},
            error=True,
        )
        assert "Folder not found" in missing_parent["content"][0]["text"]

        created = await call_tool(
            "create_note",
            {
                "path": "MCPルート/自動/パス作成.md",
                "content": "# パス作成\n\n自動作成されたノート",
            },
        )
        assert created["path"] == "MCPルート/自動/パス作成.md"
        assert [folder["name"] for folder in created["folder_path"]] == [
            "MCPルート", "自動"
        ]
        assert created["created_by"] == "構成担当"
        assert created["created_via"] == "Test ChatGPT"

        reused = await call_tool(
            "create_note",
            {
                "path": "MCPルート/自動/再利用.md",
                "content": "# 再利用",
            },
        )
        assert reused["folder_id"] == created["folder_id"]

        maximum = await call_tool(
            "create_note",
            {
                "path": "新規一/新規二/新規三/最大階層.md",
                "content": "# 最大階層",
            },
        )
        assert len(maximum["folder_path"]) == 3

        legacy = await call_tool(
            "create_note",
            {
                "filename": "従来指定.md",
                "folder_id": root["id"],
                "content": "# 従来指定",
            },
        )
        assert legacy["path"] == "MCPルート/従来指定.md"

        unfiled = await call_tool(
            "create_note",
            {
                "filename": "未整理重複.md",
                "content": "# 未整理",
            },
        )
        assert unfiled["path"] == "未整理重複.md"
        duplicate_unfiled = await call_tool(
            "create_note",
            {
                "filename": "未整理重複.md",
                "content": "# 未整理の重複",
            },
            error=True,
        )
        assert "already exists" in duplicate_unfiled["content"][0]["text"]

        duplicate_note = await call_tool(
            "create_note",
            {
                "path": created["path"],
                "content": "# 重複",
            },
            error=True,
        )
        assert "already exists" in duplicate_note["content"][0]["text"]

        too_deep = await call_tool(
            "create_note",
            {
                "path": "ロールバック/一/二/三/超過.md",
                "content": "# 超過",
            },
            error=True,
        )
        assert "cannot exceed 3" in too_deep["content"][0]["text"]

        invalid_paths = (
            "",
            "/先頭.md",
            "二重//区切り.md",
            "相対/../不正.md",
            "逆\\区切り.md",
            "拡張子なし/不正.txt",
        )
        for note_path in invalid_paths:
            invalid = await call_tool(
                "create_note",
                {"path": note_path, "content": "# 不正"},
                error=True,
            )
            assert "error" in invalid["content"][0]["text"]

        mixed_destination = await call_tool(
            "create_note",
            {
                "path": "混在/不正.md",
                "folder_id": root["id"],
                "content": "# 不正",
            },
            error=True,
        )
        assert "folder_id cannot be used" in mixed_destination["content"][0]["text"]

        folders = await call_tool("list_folders", {})
        items = folders["items"]
        assert sum(item["name"] == "MCPルート" for item in items) == 1
        assert sum(item["name"] == "自動" for item in items) == 1
        assert not any(item["name"] in {"第四階層", "孤立", "ロールバック"} for item in items)


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


def test_get_note_by_workspace_path(tmp_path: Path):
    database = Database(tmp_path / "path-lookup.sqlite3")
    database.initialize()
    projects = database.create_folder("Projects")
    guides = database.create_folder("Guides", projects["id"])
    nested = database.create_note(
        "Setup.md", "# Setup", guides["id"]
    )
    unfiled = database.create_note("memo.md", "# memo")

    assert database.get_note_by_path("Projects/Guides/Setup.md")["id"] == nested["id"]
    assert database.get_note_by_path("Projects/Guides/Setup.md")["path"] == (
        "Projects/Guides/Setup.md"
    )
    assert database.get_note_by_path("memo.md")["id"] == unfiled["id"]
    assert database.get_note_by_path("Projects/Guides/setup.md") is None
    assert database.get_note_by_path("missing.md") is None

    for invalid_path in (
        "",
        "/memo.md",
        "Projects//Setup.md",
        "Projects/../Setup.md",
        "Projects\\Setup.md",
        "Projects/Setup",
    ):
        with pytest.raises(ValueError):
            database.get_note_by_path(invalid_path)

    with database.connect() as connection:
        connection.execute(
            "INSERT INTO folders VALUES ('duplicate-a', 'Duplicate', NULL, 1, 1, 1)"
        )
        connection.execute(
            "INSERT INTO folders VALUES ('duplicate-b', 'Duplicate', NULL, 2, 1, 1)"
        )
    duplicate_a = {"id": "duplicate-a"}
    duplicate_b = {"id": "duplicate-b"}
    database.create_note("same.md", "# first", duplicate_a["id"])
    database.create_note("same.md", "# second", duplicate_b["id"])
    with pytest.raises(ValueError, match="ambiguous"):
        database.get_note_by_path("Duplicate/same.md")


@pytest.mark.anyio
async def test_workspace_name_order_matches_api_and_mcp(tmp_path: Path):
    async with make_client(tmp_path, bypass=False) as client:
        access_token = await oauth_token(client)
        headers = {"Authorization": f"Bearer {access_token}"}

        async def create_folder(name: str, parent_id: str | None = None) -> dict:
            response = await client.post(
                "/api/folders",
                headers=headers,
                json={"name": name, "parent_id": parent_id},
            )
            assert response.status_code == 201
            return response.json()

        zulu = await create_folder("Zulu")
        beta = await create_folder("beta")
        alpha = await create_folder("Alpha")
        await create_folder("Zulu-child", alpha["id"])
        await create_folder("beta-child", alpha["id"])
        await create_folder("Alpha-child", alpha["id"])

        for filename in ("Zulu.md", "beta.md", "Alpha.md"):
            response = await client.post(
                "/api/notes",
                headers=headers,
                json={"filename": filename, "folder_id": alpha["id"]},
            )
            assert response.status_code == 201
        for filename in ("Zulu-unfiled.md", "Alpha-unfiled.md"):
            response = await client.post(
                "/api/notes", headers=headers, json={"filename": filename}
            )
            assert response.status_code == 201

        tree = (await client.get("/api/tree", headers=headers)).json()
        assert [folder["name"] for folder in tree] == [
            "未整理", "Alpha", "beta", "Zulu", "ようこそ"
        ]
        assert [note["filename"] for note in tree[0]["notes"]] == [
            "Alpha-unfiled.md", "Zulu-unfiled.md"
        ]
        alpha_node = next(folder for folder in tree if folder["id"] == alpha["id"])
        assert [folder["name"] for folder in alpha_node["folders"]] == [
            "Alpha-child", "beta-child", "Zulu-child"
        ]
        assert [note["filename"] for note in alpha_node["notes"]] == [
            "Alpha.md", "beta.md", "Zulu.md"
        ]

        response = await client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": "sorted-folders",
                "method": "tools/call",
                "params": {"name": "list_folders", "arguments": {}},
            },
        )
        assert response.status_code == 200
        result = response.json()["result"]
        assert result["isError"] is False
        items = result["structuredContent"]["items"]
        assert [(item["name"], item["depth"]) for item in items] == [
            ("Alpha", 1),
            ("Alpha-child", 2),
            ("beta-child", 2),
            ("Zulu-child", 2),
            ("beta", 1),
            ("Zulu", 1),
            ("ようこそ", 1),
        ]
        assert {alpha["id"], beta["id"], zulu["id"]} <= {
            item["id"] for item in items
        }


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


def test_only_seed_notes_receive_brand_case_migration(tmp_path: Path):
    database = Database(tmp_path / "brand-migration.sqlite3")
    database.initialize()
    with database.connect() as connection:
        welcome_folder = connection.execute(
            "SELECT id FROM folders WHERE name = 'ようこそ' AND parent_id IS NULL"
        ).fetchone()["id"]
        seed = connection.execute(
            "SELECT * FROM notes WHERE folder_id = ? AND filename = '01-ようこそ.md'",
            (welcome_folder,),
        ).fetchone()
        legacy_content = SEED_NOTES["01-ようこそ.md"].replace("aonote", "Aonote")
        connection.execute(
            "UPDATE notes SET title = 'Aonoteへようこそ', content = ? WHERE id = ?",
            (legacy_content, seed["id"]),
        )
        legacy_mcp = connection.execute(
            "SELECT * FROM notes WHERE folder_id = ? AND filename = '02-MCP連携.md'",
            (welcome_folder,),
        ).fetchone()
        legacy_skill = connection.execute(
            "SELECT * FROM notes WHERE folder_id = ? AND filename = '04-Agent Skill.md'",
            (welcome_folder,),
        ).fetchone()
        connection.execute(
            "UPDATE notes SET content = ? WHERE id = ?",
            (PRE_FOLDER_MCP_NOTE, legacy_mcp["id"]),
        )
        connection.execute(
            "UPDATE notes SET content = ? WHERE id = ?",
            (PRE_FOLDER_AGENT_SKILL_NOTE, legacy_skill["id"]),
        )
        customized_seed = connection.execute(
            "SELECT * FROM notes WHERE folder_id = ? AND filename = '03-SQLite全文検索.md'",
            (welcome_folder,),
        ).fetchone()
        connection.execute(
            "UPDATE notes SET title = 'AONOTEの個人設定', content = '# AONOTEの個人設定' "
            "WHERE id = ?",
            (customized_seed["id"],),
        )
        original_version = seed["version"]
        original_updated_at = seed["updated_at"]

    personal = database.create_note(
        "個人メモ.md", "# Aonoteを残す\n\nユーザー本文", welcome_folder
    )
    other_folder = database.create_folder("別フォルダ")
    lookalike = database.create_note(
        "01-ようこそ.md",
        legacy_content,
        other_folder["id"],
    )

    database.initialize()
    migrated = database.get_note(seed["id"])
    assert migrated is not None
    assert migrated["title"] == "aonoteへようこそ"
    assert migrated["content"] == SEED_NOTES["01-ようこそ.md"]
    assert migrated["version"] == original_version + 1
    assert migrated["updated_at"] == original_updated_at
    assert database.get_note(legacy_mcp["id"])["content"] == SEED_NOTES["02-MCP連携.md"]
    assert database.get_note(legacy_mcp["id"])["version"] == legacy_mcp["version"] + 1
    assert database.get_note(legacy_skill["id"])["content"] == SEED_NOTES["04-Agent Skill.md"]
    assert database.get_note(legacy_skill["id"])["version"] == legacy_skill["version"] + 1
    assert database.get_note(customized_seed["id"])["content"] == "# AONOTEの個人設定"
    assert database.get_note(personal["id"])["content"] == personal["content"]
    assert database.get_note(lookalike["id"])["content"] == lookalike["content"]

    database.initialize()
    assert database.get_note(seed["id"])["version"] == original_version + 1
    assert database.get_note(legacy_mcp["id"])["version"] == legacy_mcp["version"] + 1
    assert database.get_note(legacy_skill["id"])["version"] == legacy_skill["version"] + 1
    with database.connect() as connection:
        revisions = connection.execute(
            "SELECT title, content, version FROM note_revisions WHERE note_id = ?",
            (seed["id"],),
        ).fetchall()
        assert [dict(revision) for revision in revisions] == [
            {
                "title": "Aonoteへようこそ",
                "content": legacy_content,
                "version": original_version,
            }
        ]
        assert connection.execute(
            "SELECT COUNT(*) FROM note_revisions WHERE note_id IN (?, ?)",
            (legacy_mcp["id"], legacy_skill["id"]),
        ).fetchone()[0] == 2
