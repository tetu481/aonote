import base64
import hashlib
import html
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from threading import Barrier
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from aonote.application import create_app
from aonote.config import Settings
from aonote.mcp import TOOLS
from aonote.security import now_ts, token_hash


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(
        database_path=tmp_path / "consistency.sqlite3", base_url="http://testserver",
        admin_password="test-password", dev_bypass_auth=False,
    ))


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.post("/api/session", json={"password": "test-password"})).status_code == 200
        yield client


def access_token(db, scope, *, expires=None, resource="http://testserver/mcp"):
    with db.connect(write=True) as connection:
        connection.execute("INSERT OR IGNORE INTO oauth_clients VALUES (?, ?, ?, ?)", (
            "consistency-client", "Test agent", '["https://example.com/callback"]', now_ts(),
        ))
        connection.execute("""INSERT OR REPLACE INTO oauth_tokens
            (token_hash, token_kind, client_id, scope, resource, expires_at, actor_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)""", (
            token_hash("consistency-token"), "access", "consistency-client", scope,
            resource, expires if expires is not None else now_ts() + 300, "Test author",
        ))
        db._migrate_oauth_connections(connection)
    return {"Authorization": "Bearer consistency-token"}


def rpc(name, arguments):
    return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}


class SnippetTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, attrs))


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["危", "needle", "<img", "&lt;", "日本語"])
async def test_search_snippets_are_text_with_safe_highlights(app, client, query):
    db = app.state.db
    content = f'# Search\n\n{query} <img src=x onerror="window.__aonoteXss=1"> &lt;svg/onload=alert(1)&gt; <mark>literal</mark>'
    note = db.create_note("search-safety.md", content)
    response = await client.get("/api/search", params={"q": query})
    assert response.status_code == 200
    result = next(item for item in response.json()["results"] if item["id"] == note["id"])
    parser = SnippetTags()
    parser.feed(result["snippet"])
    assert all(tag == "mark" and attrs == [] for tag, attrs in parser.tags)
    plain = "".join(part["text"] for part in result["snippet_parts"])
    assert query in plain
    assert html.unescape(re.sub(r"</?mark>", "", result["snippet"])) == plain
    assert all(isinstance(part["highlight"], bool) for part in result["snippet_parts"])
    if len(query) >= 3:
        assert any(part["highlight"] for part in result["snippet_parts"])
    assert db.get_note(note["id"])["content"] == content


@pytest.mark.anyio
@pytest.mark.parametrize("scope,allowed", [
    ("notes:read", False), ("notes:write", False), ("", False),
    ("notes:search", True), ("notes:read notes:search", True),
])
async def test_rest_and_mcp_search_require_the_same_scope(app, scope, allowed):
    headers = access_token(app.state.db, scope)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        rest = await client.get("/api/search?q=aonote", headers=headers)
        mcp = await client.post("/mcp", headers=headers, json=rpc("search_notes", {"query": "aonote"}))
        assert rest.status_code == (200 if allowed else 403)
        assert mcp.status_code == 200
        assert mcp.json()["result"]["isError"] is (not allowed)
        if allowed:
            assert mcp.json()["result"]["structuredContent"]["items"] == rest.json()["results"]
        else:
            assert "notes:search" in rest.json()["detail"]


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["missing", "expired", "wrong-resource"])
async def test_search_rejects_invalid_authentication(app, kind):
    headers = {} if kind == "missing" else access_token(
        app.state.db, "notes:search", expires=0 if kind == "expired" else None,
        resource="https://different.example/mcp" if kind == "wrong-resource" else "http://testserver/mcp",
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.get("/api/search?q=aonote", headers=headers)).status_code == 401


@pytest.mark.anyio
@pytest.mark.parametrize("version", [None, 0, -1, True, 1.5, "1", "missing"])
async def test_rest_update_requires_a_positive_integer_version(app, client, version):
    note = app.state.db.create_note("version.md", "# Original")
    payload = {"content": "# Must not save"}
    if version != "missing":
        payload["version"] = version
    result = await client.patch(f"/api/notes/{note['id']}", json=payload)
    assert result.status_code == 422
    assert app.state.db.get_note(note["id"]) == note


@pytest.mark.anyio
@pytest.mark.parametrize("filename", ["bad/name.md", "bad\\name.md", "   ", "a" * 180])
async def test_rest_update_rejects_bad_filename_without_partial_write(app, client, filename):
    db = app.state.db
    note = db.create_note("valid.md", "# Original")
    result = await client.patch(f"/api/notes/{note['id']}", json={"filename": filename, "content": "Must not save", "version": 1})
    assert result.status_code == 400
    assert db.get_note(note["id"]) == note
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM note_revisions WHERE note_id = ?", (note["id"],)).fetchone()[0] == 0
        assert connection.execute("SELECT content FROM note_fts WHERE note_id = ?", (note["id"],)).fetchone()[0] == "# Original"


@pytest.mark.anyio
@pytest.mark.parametrize("destination", [None, "unfiled"])
async def test_rename_and_move_cannot_duplicate_unfiled_names(app, client, destination):
    db = app.state.db
    existing = db.create_note("same.md", "# Unfiled")
    folder = db.create_folder("Move source")
    source = db.create_note("source.md", "# Source", folder["id"])
    result = await client.patch(f"/api/notes/{source['id']}/location", json={
        "filename": "same.md", "folder_id": destination, "version": source["version"],
    })
    assert result.status_code == 409
    unfiled = db.create_note("another.md", "# Another")
    result = await client.patch(f"/api/notes/{unfiled['id']}", json={"filename": "same.md", "version": 1})
    assert result.status_code == 409
    assert db.get_note(source["id"]) == source
    assert db.get_note(unfiled["id"]) == unfiled
    assert db.get_note_by_path("same.md")["id"] == existing["id"]


@pytest.mark.anyio
async def test_mcp_rename_and_move_cannot_duplicate_unfiled_names(app):
    db = app.state.db
    existing = db.create_note("same.md", "# Existing")
    unfiled = db.create_note("another.md", "# Another")
    folder = db.create_folder("MCP source")
    source = db.create_note("same.md", "# Source", folder["id"])
    headers = access_token(db, "notes:read notes:write")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        for name, args in [
            ("rename_note", {"note_id": unfiled["id"], "filename": "same.md", "version": 1}),
            ("move_note", {"note_id": source["id"], "folder_id": None, "version": 1}),
        ]:
            result = await client.post("/mcp", headers=headers, json=rpc(name, args))
            assert result.json()["result"]["isError"] is True
    assert db.get_note(source["id"]) == source
    assert db.get_note(unfiled["id"]) == unfiled
    assert db.get_note_by_path("same.md")["id"] == existing["id"]


@pytest.mark.anyio
@pytest.mark.parametrize("collision", ["unfiled", "descendant"])
async def test_folder_delete_is_atomic_on_name_collision(app, client, collision):
    db = app.state.db
    root = db.create_folder("Delete root")
    child = db.create_folder("Child", root["id"])
    db.create_note("same.md", "# One", root["id"])
    db.create_note("safe.md", "# Keep me too", child["id"])
    db.create_note("same.md", "# Two", None if collision == "unfiled" else child["id"])
    before = db.list_tree()
    result = await client.delete(f"/api/folders/{root['id']}")
    assert result.status_code == 409
    assert "同名" in result.json()["detail"]
    assert db.list_tree() == before


def test_concurrent_unfiled_renames_allow_only_one_winner(app):
    db = app.state.db
    notes = [db.create_note(f"original-{i}.md", f"# {i}") for i in range(2)]
    barrier = Barrier(2)

    def rename(note):
        barrier.wait(timeout=5)
        try:
            db.update_note(note["id"], filename="same.md", expected_version=1)
            return "ok"
        except sqlite3.IntegrityError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(rename, notes)) == ["conflict", "ok"]
    assert db.get_note_by_path("same.md") is not None
    assert all(db.get_note(note["id"])["content"] == note["content"] for note in notes)


def test_wikilinks_resolve_paths_local_names_and_ambiguity(app):
    db = app.state.db
    a = db.create_folder("A")
    b = db.create_folder("B")
    child = db.create_folder("Child", b["id"])
    first = db.create_note("same.md", "# Same title", a["id"])
    second = db.create_note("same.md", "# Same title", child["id"])
    source = db.create_note("source.md", "\n".join([
        "[[A/same]]", "[[A/same.md|Alias]]", "[[B/Child/same.md]]", "[[Missing/same]]",
        "[[a/same]]", "[[same]]", "[[same.md]]", "[[Same title]]", "[[ A/same.md ]]",
    ]), a["id"])
    links = {link["target"]: link["id"] for link in source["links"]}
    assert links == {
        "A/same": first["id"], "A/same.md": first["id"], "B/Child/same.md": second["id"],
        "Missing/same": None, "a/same": None, "same": first["id"], "same.md": first["id"], "Same title": first["id"],
    }
    outside = db.create_note("outside.md", "[[same]] [[Same title]] [[A/same]]")
    assert {link["target"]: link["id"] for link in outside["links"]} == {"same": None, "Same title": None, "A/same": first["id"]}
    assert any(link["id"] == source["id"] for link in db.get_note(first["id"])["backlinks"])
    backlinks = db.get_note(first["id"])["backlinks"]
    assert len(backlinks) == len({link["id"] for link in backlinks})
    # Correct persisted targets from earlier releases on startup.
    with db.connect() as connection:
        connection.execute("UPDATE note_links SET target_id = ? WHERE source_id = ? AND target_label = 'A/same'", (second["id"], source["id"]))
    db.initialize()
    assert next(link for link in db.get_note(source["id"])["links"] if link["target"] == "A/same")["id"] == first["id"]
    db.rename_folder(a["id"], "Renamed")
    assert next(link for link in db.get_note(source["id"])["links"] if link["target"] == "A/same")["id"] is None
    db.delete_folder(b["id"])
    assert next(link for link in db.get_note(source["id"])["links"] if link["target"] == "B/Child/same.md")["id"] is None
    assert db.get_note_by_path("same.md")["id"] == second["id"]


def test_deleted_notes_do_not_prevent_name_reuse(app):
    db = app.state.db
    old = db.create_note("reusable.md", "# Deleted")
    db.delete_note(old["id"])
    note = db.create_note("source.md", "# Active")
    renamed = db.update_note(note["id"], filename="reusable.md", expected_version=1)
    assert renamed["filename"] == "reusable.md"
    with pytest.raises(sqlite3.IntegrityError):
        db.restore_note(old["id"])


def valid_tool_arguments(name, note):
    return {
        "get_note": {"note_id": note["id"]},
        "create_folder": {"name": "Must not be created"},
        "search_notes": {"query": "Original"},
        "create_note": {"path": "Must not exist/new.md", "content": "# New"},
        "update_note": {"note_id": note["id"], "content": "# Updated", "version": note["version"]},
        "rename_note": {"note_id": note["id"], "filename": "renamed.md", "version": note["version"]},
        "move_note": {"note_id": note["id"], "folder_id": None, "version": note["version"]},
        "delete_note": {"note_id": note["id"]},
        "list_notes": {"limit": 10},
        "list_folders": {},
    }[name]


def assert_note_unchanged(db, note, tree):
    assert db.get_note(note["id"]) == note
    assert db.list_tree() == tree
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM note_revisions WHERE note_id = ?", (note["id"],)).fetchone()[0] == 0
        assert connection.execute("SELECT content FROM note_fts WHERE note_id = ?", (note["id"],)).fetchone()[0] == note["content"]


@pytest.mark.anyio
@pytest.mark.parametrize("name,missing", [
    (tool["name"], field)
    for tool in TOOLS for field in tool["inputSchema"].get("required", [])
])
async def test_mcp_enforces_all_published_required_arguments(app, client, name, missing):
    db = app.state.db
    folder = db.create_folder("Origin")
    note = db.create_note("original.md", "# Original", folder["id"])
    tree = db.list_tree()
    arguments = valid_tool_arguments(name, note)
    del arguments[missing]
    response = await client.post("/mcp", headers=access_token(db, "notes:read notes:search notes:write"), json=rpc(name, arguments))
    assert response.status_code == 200
    assert response.json()["result"]["isError"] is True
    assert f"{missing} is required" in response.json()["result"]["content"][0]["text"]
    assert_note_unchanged(db, note, tree)


@pytest.mark.anyio
@pytest.mark.parametrize("version", [None, False, True, "1", 1.1, 1.9, 0, -1])
async def test_mcp_updates_reject_nonpositive_or_coerced_versions(app, client, version):
    db = app.state.db
    note = db.create_note("original.md", "# Original")
    tree = db.list_tree()
    headers = access_token(db, "notes:write")
    for name in ["update_note", "rename_note", "move_note"]:
        arguments = {**valid_tool_arguments(name, note), "version": version}
        response = await client.post("/mcp", headers=headers, json=rpc(name, arguments))
        assert response.json()["result"]["isError"] is True
        assert_note_unchanged(db, note, tree)


@pytest.mark.anyio
@pytest.mark.parametrize("name,invalid", [
    ("update_note", {"content": None}), ("update_note", {"content": ["bad"]}),
    ("update_note", {"filename": 123}), ("move_note", {"folder_id": False}),
    ("create_note", {"content": None}), ("create_note", {"path": 123}),
    ("create_folder", {"name": False}), ("create_folder", {"name": ""}),
    ("get_note", {"note_id": ["bad"]}), ("search_notes", {"query": None}),
    ("list_notes", {"limit": True}), ("list_notes", {"limit": 0}),
    ("list_notes", {"limit": 51}),
])
async def test_mcp_rejects_wrong_types_and_bounds_without_mutations(app, client, name, invalid):
    db = app.state.db
    note = db.create_note("original.md", "# Original")
    tree = db.list_tree()
    response = await client.post("/mcp", headers=access_token(db, "notes:read notes:search notes:write"), json=rpc(name, {**valid_tool_arguments(name, note), **invalid}))
    assert response.json()["result"]["isError"] is True
    assert_note_unchanged(db, note, tree)


@pytest.mark.anyio
async def test_mcp_allows_explicit_empty_content_and_null_destination(app, client):
    db = app.state.db
    folder = db.create_folder("Origin")
    note = db.create_note("original.md", "# Original", folder["id"])
    headers = access_token(db, "notes:write")
    emptied = await client.post("/mcp", headers=headers, json=rpc("update_note", {"note_id": note["id"], "content": "", "version": 1}))
    assert emptied.json()["result"]["isError"] is False
    assert db.get_note(note["id"])["content"] == ""
    moved = await client.post("/mcp", headers=headers, json=rpc("move_note", {"note_id": note["id"], "folder_id": None, "version": 2}))
    assert moved.json()["result"]["isError"] is False
    assert db.get_note(note["id"])["folder_id"] is None


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["", "?", "?existing=value", "?tag=a&tag=b&empty=&raw=a%2Fb&plus=a+b"])
@pytest.mark.parametrize("state", ["", "opaque state + / ? & 日本語"])
async def test_oauth_preserves_registered_callback_query_and_exchanges_code(client, query, state):
    redirect_uri = f"https://example.com/callback{query}"
    registered = await client.post("/oauth/register", json={"client_name": "Query callback", "redirect_uris": [redirect_uri]})
    assert registered.status_code == 201
    client_id = registered.json()["client_id"]
    verifier = "a" * 50
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    authorization = await client.post("/oauth/authorize", data={
        "client_id": client_id, "redirect_uri": redirect_uri, "resource": "http://testserver/mcp",
        "scope": "notes:read", "requested_scope": "notes:read", "code_challenge": challenge,
        "code_challenge_method": "S256", "actor_name": "Query tester", "password": "test-password", "state": state,
    })
    assert authorization.status_code == 303
    destination = urlparse(authorization.headers["location"])
    response_query = parse_qs(destination.query, keep_blank_values=True)
    assert len(response_query["code"]) == 1
    for key, values in parse_qs(urlparse(redirect_uri).query, keep_blank_values=True).items():
        assert response_query[key] == values
    assert response_query.get("state") == ([state] if state else None)
    if urlparse(redirect_uri).query:
        assert destination.query.startswith(urlparse(redirect_uri).query + "&")
    exchanged = await client.post("/oauth/token", data={
        "grant_type": "authorization_code", "client_id": client_id, "code": response_query["code"][0],
        "redirect_uri": redirect_uri, "resource": "http://testserver/mcp", "code_verifier": verifier,
    })
    assert exchanged.status_code == 200
    assert exchanged.json()["scope"] == "notes:read"
