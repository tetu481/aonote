import asyncio
import base64
import hashlib
import json
import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Barrier, Event
from types import SimpleNamespace

import httpx
import pytest

from aonote import observability
from aonote.application import create_app
from aonote.config import Settings
from aonote.db import Database, VersionConflict
from aonote.security import now_ts, token_hash


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def app(tmp_path):
    app = create_app(Settings(
        database_path=tmp_path / "aonote.sqlite3", base_url="http://testserver",
        admin_password="secret-password-marker", dev_bypass_auth=True,
        min_free_disk_mb=1, monitor_interval_seconds=1,
    ))
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text('<script src="/assets/index.js"></script>')
    (static / "assets" / "index.js").write_text("/* test bundle */")
    app.state.static_dir = static
    return app


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver",
    ) as client:
        yield client


def seed_grant(db, grant_type):
    verifier = "secret-verifier-marker-123456789012345678901234567890"
    resource = "http://testserver/mcp"
    with db.connect(write=True) as connection:
        connection.execute("INSERT INTO oauth_clients VALUES (?, ?, ?, ?)", (
            "client", "Diagnostic", '["https://example.com/callback"]', now_ts(),
        ))
        if grant_type == "authorization_code":
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            connection.execute("INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
                token_hash("secret-code-marker"), "client", "https://example.com/callback",
                "notes:read notes:write", resource, challenge, now_ts() + 300, "担当",
            ))
        else:
            connection.execute("INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?, ?)", (
                token_hash("secret-refresh-marker"), "refresh", "client", "notes:read notes:write",
                resource, now_ts() + 300, "担当",
            ))
    return {
        "grant_type": grant_type, "client_id": "client", "resource": resource,
        "code": "secret-code-marker", "code_verifier": verifier,
        "redirect_uri": "https://example.com/callback", "refresh_token": "secret-refresh-marker",
    }


def seed_access(db):
    seed_grant(db, "refresh_token")
    with db.connect(write=True) as connection:
        connection.execute("INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?, ?)", (
            token_hash("secret-access-marker"), "access", "client", "notes:read notes:search notes:write",
            "http://testserver/mcp", now_ts() + 300, "担当",
        ))
    return {"Authorization": "Bearer secret-access-marker"}


def rpc(name, arguments):
    return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}


@pytest.mark.anyio
@pytest.mark.parametrize("grant_type", ["authorization_code", "refresh_token"])
async def test_oauth_issuance_rolls_back_consumption_and_partial_tokens(app, client, grant_type):
    db = app.state.db
    data = seed_grant(db, grant_type)
    with db.connect() as connection:
        before_tokens = [tuple(row) for row in connection.execute("SELECT * FROM oauth_tokens")]
        before_codes = [tuple(row) for row in connection.execute("SELECT * FROM oauth_codes")]
        connection.execute("""CREATE TRIGGER fail_issue BEFORE INSERT ON oauth_tokens
            WHEN NEW.token_kind = 'refresh'
            BEGIN SELECT RAISE(ABORT, 'secret-database-error-marker'); END""")
    failed = await client.post("/oauth/token", data=data)
    assert failed.status_code == 503
    assert failed.json() == {"error": "temporarily_unavailable"}
    assert failed.headers["Cache-Control"] == "no-store"
    with db.connect() as connection:
        assert [tuple(row) for row in connection.execute("SELECT * FROM oauth_tokens")] == before_tokens
        assert [tuple(row) for row in connection.execute("SELECT * FROM oauth_codes")] == before_codes
        connection.execute("DROP TRIGGER fail_issue")
    retried = await client.post("/oauth/token", data=data)
    assert retried.status_code == 200
    assert retried.json()["scope"] == "notes:read notes:write"
    replay = await client.post("/oauth/token", data=data)
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"


@pytest.mark.anyio
@pytest.mark.parametrize("grant_type", ["authorization_code", "refresh_token"])
async def test_oauth_concurrent_exchange_is_single_use(app, client, grant_type):
    data = seed_grant(app.state.db, grant_type)
    results = await asyncio.gather(*(client.post("/oauth/token", data=data) for _ in range(2)))
    assert sorted(result.status_code for result in results) == [200, 400]
    with app.state.db.connect() as connection:
        rows = connection.execute("SELECT token_kind, scope, actor_name FROM oauth_tokens").fetchall()
    assert sorted(row["token_kind"] for row in rows) == ["access", "refresh"]
    assert all(row["scope"] == "notes:read notes:write" and row["actor_name"] == "担当" for row in rows)


@pytest.mark.anyio
async def test_concurrent_rest_and_mcp_update_rejects_one_and_keeps_history(app, client):
    db = app.state.db
    headers = seed_access(db)
    note = db.create_note("concurrent.md", "# Original")
    results = await asyncio.gather(
        client.patch(f"/api/notes/{note['id']}", json={"content": "# Browser", "version": 1}),
        client.post("/mcp", headers=headers, json=rpc("update_note", {
            "note_id": note["id"], "content": "# Agent", "version": 1,
        })),
    )
    browser_ok = results[0].status_code == 200
    assert results[1].json()["result"]["isError"] is browser_ok
    assert results[0].status_code in {200, 409}
    current = db.get_note(note["id"])
    assert current["version"] == 2
    assert current["content"] == ("# Browser" if browser_ok else "# Agent")
    with db.connect() as connection:
        revisions = connection.execute("SELECT version, content FROM note_revisions WHERE note_id = ?", (note["id"],)).fetchall()
        assert [tuple(row) for row in revisions] == [(1, "# Original")]
        assert connection.execute("SELECT content FROM note_fts WHERE note_id = ?", (note["id"],)).fetchone()[0] == current["content"]


def test_independent_database_connections_serialize_versions(app):
    db = app.state.db
    note = db.create_note("parallel.md", "# Original")
    start = Barrier(2)

    def update(content):
        independent_db = Database(db.path)
        start.wait(timeout=5)
        try:
            independent_db.update_note(note["id"], content=content, expected_version=1)
            return "saved"
        except VersionConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(update, ["# First", "# Second"])) == ["conflict", "saved"]


def test_read_transaction_keeps_a_consistent_snapshot_during_updates(app):
    db = app.state.db
    note = db.create_note("snapshot.md", "# Original")
    with db.connect() as connection:
        assert connection.execute("SELECT content FROM notes WHERE id = ?", (note["id"],)).fetchone()[0] == "# Original"
        db.update_note(note["id"], content="# Updated", expected_version=1)
        assert connection.execute("SELECT content FROM notes WHERE id = ?", (note["id"],)).fetchone()[0] == "# Original"
    assert db.get_note(note["id"])["content"] == "# Updated"


@pytest.mark.parametrize("path", ["same.md", "Parallel/Nested/same.md"])
def test_concurrent_duplicate_creation_has_one_winner(app, path):
    db = app.state.db
    start = Barrier(2)

    def create(_):
        start.wait(timeout=5)
        try:
            Database(db.path).create_note_by_path(path, "# Created")
            return "created"
        except sqlite3.IntegrityError:
            return "duplicate"

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(create, range(2))) == ["created", "duplicate"]
    assert db.get_note_by_path(path) is not None


def test_concurrent_path_creation_reuses_folders_without_duplicates(app):
    db = app.state.db
    start = Barrier(2)

    def create(filename):
        start.wait(timeout=5)
        return Database(db.path).create_note_by_path(f"Parallel/Nested/{filename}", "# Created")

    with ThreadPoolExecutor(max_workers=2) as pool:
        notes = list(pool.map(create, ["a.md", "b.md"]))
    assert notes[0]["folder_id"] == notes[1]["folder_id"]
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM folders WHERE name IN ('Parallel', 'Nested')").fetchone()[0] == 2


@pytest.mark.anyio
async def test_update_failure_rolls_back_content_version_history_and_search(app, client, monkeypatch):
    db = app.state.db
    note = db.create_note("rollback.md", "# Original")

    def fail(*args):
        raise sqlite3.OperationalError("secret-database-error-marker")

    monkeypatch.setattr(db, "_reindex", fail)
    response = await client.patch(f"/api/notes/{note['id']}", json={"content": "# Changed", "version": 1})
    assert response.status_code == 503
    assert "secret-database-error-marker" not in response.text
    assert db.get_note(note["id"]) == note
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM note_revisions WHERE note_id = ?", (note["id"],)).fetchone()[0] == 0
        assert connection.execute("SELECT content FROM note_fts WHERE note_id = ?", (note["id"],)).fetchone()[0] == "# Original"


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["api", "mcp", "oauth"])
async def test_slow_database_work_does_not_block_health_or_discovery(app, client, monkeypatch, operation):
    db = app.state.db
    started, release = Event(), Event()
    original_search = db.search
    original_connect = db.connect

    def wait_for_release():
        started.set()
        assert release.wait(timeout=5), "Test worker was not released"

    def slow_search(*args):
        wait_for_release()
        return original_search(*args)

    @contextmanager
    def slow_connect(*, write=False):
        if write:
            wait_for_release()
        with original_connect(write=write) as connection:
            yield connection

    if operation == "oauth":
        data = seed_grant(db, "refresh_token")
        monkeypatch.setattr(db, "connect", slow_connect)
        request = client.post("/oauth/token", data=data)
    else:
        headers = seed_access(db)
        monkeypatch.setattr(db, "search", slow_search)
        request = client.get("/api/search?q=test") if operation == "api" else client.post(
            "/mcp", headers=headers, json=rpc("search_notes", {"query": "test"}),
        )
    task = asyncio.create_task(request)
    try:
        assert await asyncio.to_thread(started.wait, 2)
        assert not task.done()
        health = await asyncio.wait_for(client.get("/healthz"), timeout=1)
        discovery = await asyncio.wait_for(client.get("/.well-known/oauth-authorization-server"), timeout=1)
        assert health.status_code == discovery.status_code == 200
        assert not task.done()
    finally:
        release.set()
        await task
    assert task.result().status_code == 200


@pytest.mark.anyio
async def test_readiness_and_liveness_with_low_disk_and_missing_frontend(app, client, monkeypatch):
    assert (await client.get("/readyz")).status_code == 200
    monkeypatch.setattr(observability.shutil, "disk_usage", lambda path: SimpleNamespace(free=0))
    low_disk = await client.get("/readyz")
    assert low_disk.status_code == 503
    assert low_disk.json()["checks"]["disk"] == "low_disk_space"
    app.state.static_dir = Path("/nonexistent-aonote-test-static")
    missing = await client.get("/readyz")
    assert missing.json()["checks"]["frontend"] == "frontend_unavailable"
    assert (await client.get("/healthz")).status_code == 200


@pytest.mark.anyio
async def test_readiness_does_not_recreate_missing_database(app, client):
    app.state.db.path = app.state.db.path.parent / "missing.sqlite3"
    result = await client.get("/readyz")
    assert result.status_code == 503
    assert result.json()["checks"]["database"] == "database_unavailable"
    assert not app.state.db.path.exists()


@pytest.mark.anyio
async def test_readiness_reports_readonly_storage_and_missing_bundle(app, client, monkeypatch):
    monkeypatch.setattr(observability.os, "access", lambda *args: False)
    (app.state.static_dir / "assets" / "index.js").unlink()
    result = await client.get("/readyz")
    assert result.status_code == 503
    assert result.json()["checks"]["database"] == "database_readonly"
    assert result.json()["checks"]["frontend"] == "frontend_unavailable"


@pytest.mark.anyio
async def test_readiness_detects_writer_lock_and_recovers(app, client):
    with app.state.db.connect(write=True):
        result = await client.get("/readyz")
        assert result.status_code == 503
        assert result.json()["checks"]["database"] == "database_busy"
        assert (await client.get("/healthz")).status_code == 200
    assert (await client.get("/readyz")).status_code == 200


@pytest.mark.anyio
async def test_background_monitor_logs_failures_and_recovery(app, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="aonote")
    available = {"free": 0}
    monkeypatch.setattr(observability.shutil, "disk_usage", lambda path: SimpleNamespace(free=available["free"]))

    def transitions():
        return [json.loads(record.message) for record in caplog.records if record.name == "aonote" and '"readiness_changed"' in record.message]

    async def wait_for_count(count):
        async with asyncio.timeout(4):
            while len(transitions()) < count:
                await asyncio.sleep(0.02)

    async with app.router.lifespan_context(app):
        await wait_for_count(1)
        assert transitions()[0]["checks"]["disk"] == "low_disk_space"
        available["free"] = 10 * 1024 * 1024
        await wait_for_count(2)
        assert transitions()[1]["checks"]["disk"] == "ok"


@pytest.mark.anyio
async def test_logs_have_correlation_and_reasons_but_no_secrets(app, client, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="aonote")
    headers = seed_access(app.state.db)
    created = await client.post("/mcp?private=secret-query-marker", headers=headers, json=rpc("create_note", {
        "filename": "secret-filename-marker.md", "content": "# secret-content-marker",
    }))
    assert created.json()["result"]["isError"] is False
    invalid = await client.post("/mcp", headers=headers, json=rpc("create_note", {"content": "secret-content-marker"}))
    assert invalid.json()["result"]["isError"] is True

    def fail(*args):
        error = sqlite3.OperationalError("secret-database-error-marker")
        error.sqlite_errorcode = sqlite3.SQLITE_BUSY
        raise error

    monkeypatch.setattr(app.state.db, "search", fail)
    failed = await client.post("/mcp", headers=headers, json=rpc("search_notes", {"query": "secret-query-marker"}))
    assert failed.json()["result"]["isError"] is True
    assert "database_busy" in failed.text
    assert "secret-database-error-marker" not in failed.text
    records = [json.loads(record.message) for record in caplog.records if record.name == "aonote"]
    tools = [row for row in records if row["event"] == "mcp_tool"]
    assert [row["reason"] for row in tools] == ["ok", "invalid_arguments", "database_busy"]
    assert tools[0]["request_id"] == created.headers["X-Request-ID"]
    assert tools[1]["request_id"] == invalid.headers["X-Request-ID"]
    assert tools[2]["request_id"] == failed.headers["X-Request-ID"]
    assert len({row["request_id"] for row in tools}) == 3
    assert all(row["duration_ms"] >= 0 for row in tools)
    assert "secret-" not in json.dumps(records)


@pytest.mark.anyio
@pytest.mark.parametrize("message", [None, [], 42, {"jsonrpc": "2.0", "method": 1}, {
    "jsonrpc": "2.0", "method": "tools/call", "id": 1,
    "params": {"name": "create_note", "arguments": ["invalid"]},
}])
async def test_malformed_mcp_messages_return_errors_without_crashing(app, client, message):
    headers = seed_access(app.state.db)
    result = await client.post("/mcp", headers=headers, content=json.dumps(message))
    assert result.status_code == 200
    assert result.json()["error"]["code"] in {-32600, -32602}


def test_monitor_settings_environment_and_invalid_value_fallback(monkeypatch):
    monkeypatch.setenv("AONOTE_MIN_FREE_DISK_MB", "500")
    monkeypatch.setenv("AONOTE_MONITOR_INTERVAL_SECONDS", "30")
    settings = Settings.from_env()
    assert settings.min_free_disk_mb == 500
    assert settings.monitor_interval_seconds == 30
    monkeypatch.setenv("AONOTE_MIN_FREE_DISK_MB", "-1")
    monkeypatch.setenv("AONOTE_MONITOR_INTERVAL_SECONDS", "invalid")
    settings = Settings.from_env()
    assert settings.min_free_disk_mb == 100
    assert settings.monitor_interval_seconds == 60
