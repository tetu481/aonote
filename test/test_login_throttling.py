from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import httpx
import pytest
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from aonote import login
from aonote.application import create_app
from aonote.config import Settings
from aonote.db import Database


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def clock(monkeypatch):
    value = [1_000_000]
    monkeypatch.setattr(login, "now_ts", lambda: value[0])
    return value


@pytest.fixture
def settings(tmp_path):
    return Settings(
        database_path=tmp_path / "login.sqlite3",
        base_url="http://testserver",
        admin_password="test-password",
        dev_bypass_auth=False,
    )


def client_for(app, peer=("192.0.2.10", 12345)):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=peer), base_url="http://testserver",
    )


async def password_attempt(client, password="wrong"):
    return await client.post("/api/session", json={"password": password})


async def consent_values(client):
    registration = await client.post("/oauth/register", json={
        "redirect_uris": ["http://localhost/callback"], "client_name": "Throttle test",
    })
    assert registration.status_code == 201
    return {
        "client_id": registration.json()["client_id"],
        "redirect_uri": "http://localhost/callback",
        "response_type": "code",
        "scope": "notes:read", "requested_scope": "notes:read",
        "resource": "http://testserver/mcp",
        "code_challenge": "A" * 43, "code_challenge_method": "S256",
        "actor_name": "Throttle test", "password": "wrong",
    }


@pytest.mark.parametrize("value,expected", [
    (None, 5), ("5", 5), ("1", 1), ("7", 7), (" 10 ", 10),
    ("", 5), ("0", 5), ("-1", 5), ("0.5", 5), ("invalid", 5),
])
def test_attempt_limit_environment_defaults(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("AONOTE_LOGIN_MAX_ATTEMPTS", raising=False)
    else:
        monkeypatch.setenv("AONOTE_LOGIN_MAX_ATTEMPTS", value)
    assert Settings.from_env().login_max_attempts == expected


@pytest.mark.anyio
@pytest.mark.parametrize("limit", [1, 3, 5, 7])
async def test_browser_limit_and_correct_password_blocked(settings, clock, limit):
    app = create_app(replace(settings, login_max_attempts=limit))
    async with client_for(app) as client:
        for _ in range(limit - 1):
            assert (await password_attempt(client)).status_code == 401
        blocked = await password_attempt(client)
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "900"
        assert blocked.headers["cache-control"] == "no-store"
        assert "set-cookie" not in blocked.headers
        assert (await password_attempt(client, "test-password")).status_code == 429
        assert (await client.get("/api/tree")).status_code == 401


@pytest.mark.anyio
@pytest.mark.parametrize("value", [None, "3"])
async def test_environment_limit_applies_to_actual_login(tmp_path, monkeypatch, clock, value):
    monkeypatch.setenv("AONOTE_DATABASE", str(tmp_path / "env-login.sqlite3"))
    monkeypatch.setenv("AONOTE_ADMIN_PASSWORD", "test-password")
    monkeypatch.setenv("AONOTE_DEV_BYPASS_AUTH", "false")
    if value is None:
        monkeypatch.delenv("AONOTE_LOGIN_MAX_ATTEMPTS", raising=False)
    else:
        monkeypatch.setenv("AONOTE_LOGIN_MAX_ATTEMPTS", value)
    app = create_app()
    async with client_for(app) as client:
        for _ in range(int(value or 5) - 1):
            assert (await password_attempt(client)).status_code == 401
        assert (await password_attempt(client)).status_code == 429


@pytest.mark.anyio
async def test_success_resets_failures(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        for _ in range(2):
            for _ in range(4):
                assert (await password_attempt(client)).status_code == 401
            assert (await password_attempt(client, "test-password")).status_code == 200
    with app.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0] == 0


@pytest.mark.anyio
async def test_failure_window_expires_without_lockout(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
        clock[0] += 900
        assert (await password_attempt(client)).status_code == 401
    with app.state.db.connect() as connection:
        row = connection.execute("SELECT * FROM login_attempts").fetchone()
    assert row["failed_attempts"] == 1
    assert row["window_started_at"] == clock[0]


@pytest.mark.anyio
async def test_lockout_expires_and_requests_do_not_extend_it(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        for _ in range(5):
            await password_attempt(client)
        clock[0] += 200
        blocked = await password_attempt(client)
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "700"
        clock[0] += 699
        blocked = await password_attempt(client, "test-password")
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "1"
        clock[0] += 1
        assert (await password_attempt(client, "test-password")).status_code == 200
        assert (await password_attempt(client)).status_code == 401


@pytest.mark.anyio
async def test_lockout_expiry_also_resets_counter_on_failure(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        for _ in range(5):
            await password_attempt(client)
        clock[0] += 900
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
        assert (await password_attempt(client)).status_code == 429


@pytest.mark.anyio
async def test_lockout_survives_app_restart(settings, clock):
    async with client_for(create_app(settings)) as client:
        for _ in range(5):
            await password_attempt(client)
    clock[0] += 10
    async with client_for(create_app(settings)) as restarted:
        blocked = await password_attempt(restarted, "test-password")
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "890"


@pytest.mark.anyio
async def test_browser_and_oauth_share_budget_for_same_ip(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        values = await consent_values(client)
        for _ in range(2):
            assert (await password_attempt(client)).status_code == 401
        for _ in range(2):
            assert (await client.post("/oauth/authorize", data=values)).status_code == 401
        # Different registered client and spoofed forwarding headers do not help.
        values = await consent_values(client)
        blocked = await client.post("/oauth/authorize", data=values, headers={"X-Forwarded-For": "192.0.2.123"})
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "900"
        assert "約15分後" in blocked.text
        assert "location" not in blocked.headers
        async with client_for(app) as separate_client:
            assert (await password_attempt(separate_client, "test-password")).status_code == 429
        assert (await client.get("/oauth/authorize", params={
            key: value for key, value in values.items() if key not in {"password", "actor_name", "requested_scope"}
        })).status_code == 200
    with app.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM oauth_codes").fetchone()[0] == 0


@pytest.mark.anyio
async def test_successful_oauth_resets_budget_and_existing_session_survives(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        assert (await password_attempt(client, "test-password")).status_code == 200
        values = await consent_values(client)
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
        granted = await client.post("/oauth/authorize", data={**values, "password": "test-password"})
        assert granted.status_code == 303
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
        assert (await password_attempt(client)).status_code == 429
        assert (await client.get("/api/tree")).status_code == 200


@pytest.mark.anyio
async def test_invalid_consent_does_not_consume_password_attempt(settings, clock):
    app = create_app(settings)
    async with client_for(app) as client:
        values = await consent_values(client)
        assert (await client.post("/oauth/authorize", data={**values, "scope": "invalid:scope"})).status_code == 400
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
        assert (await password_attempt(client, "test-password")).status_code == 200


def test_concurrent_independent_workers_cannot_exceed_budget(settings, clock):
    app = create_app(settings)
    start = Barrier(8)

    def attempt(_):
        db = Database(settings.database_path)
        start.wait(timeout=5)
        return login.check_login(db, settings, "wrong", "192.0.2.10")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert all(not result.authenticated for result in results)
    assert sum(result.retry_after == 0 for result in results) == 4
    assert sum(result.retry_after == 900 for result in results) == 4
    with app.state.db.connect() as connection:
        row = connection.execute("SELECT * FROM login_attempts").fetchone()
        assert row["failed_attempts"] == 5
        assert connection.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0] == 1
        assert "test-password" not in str(dict(row))


@pytest.mark.anyio
async def test_locked_attacker_does_not_block_other_ip_browser_or_oauth(settings, clock):
    app = create_app(settings)
    async with client_for(app) as attacker, client_for(app, ("192.0.2.20", 12345)) as owner:
        for _ in range(5):
            await password_attempt(attacker)
        assert (await password_attempt(attacker, "test-password")).status_code == 429
        # Real logins on a separate IP still issue a session and OAuth code.
        assert (await password_attempt(owner, "test-password")).status_code == 200
        assert (await owner.get("/api/tree")).status_code == 200
        values = await consent_values(owner)
        authorized = await owner.post("/oauth/authorize", data={**values, "password": "test-password"})
        assert authorized.status_code == 303
        assert "code=" in authorized.headers["location"]
        # The owner's successful login cannot unlock the attacker's IP.
        assert (await password_attempt(attacker, "test-password")).status_code == 429
        blocked = await attacker.post("/oauth/authorize", data={**values, "password": "test-password"})
        assert blocked.status_code == 429
        assert "location" not in blocked.headers


@pytest.mark.anyio
async def test_success_resets_only_its_own_ip(settings, clock):
    app = create_app(settings)
    async with client_for(app) as first, client_for(app, ("192.0.2.20", 12345)) as second:
        for _ in range(4):
            assert (await password_attempt(first)).status_code == 401
            assert (await password_attempt(second)).status_code == 401
        assert (await password_attempt(second, "test-password")).status_code == 200
        assert (await password_attempt(first)).status_code == 429
        assert (await password_attempt(second)).status_code == 401
    with app.state.db.connect() as connection:
        counts = dict(connection.execute("SELECT ip_address, failed_attempts FROM login_attempts"))
    assert counts == {"192.0.2.10": 5, "192.0.2.20": 1}


@pytest.mark.anyio
async def test_different_source_ports_do_not_reset_ip_limit(settings, clock):
    app = create_app(settings)
    for index in range(5):
        async with client_for(app, ("192.0.2.10", 20000 + index)) as client:
            r = await password_attempt(client)
            assert r.status_code == (429 if index == 4 else 401)


@pytest.mark.anyio
@pytest.mark.parametrize("first,second", [
    ("192.0.2.10", "::ffff:192.0.2.10"),
    ("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"),
    ("fe80::1%eth0", "fe80::1%2"),
])
async def test_equivalent_ip_spellings_share_budget(settings, clock, first, second):
    app = create_app(settings)
    async with client_for(app, (first, 12345)) as client:
        for _ in range(4):
            assert (await password_attempt(client)).status_code == 401
    async with client_for(app, (second, 12345)) as client:
        assert (await password_attempt(client)).status_code == 429
    with app.state.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0] == 1


@pytest.mark.anyio
async def test_missing_or_invalid_client_ip_cannot_bypass_limit(settings, clock):
    app = create_app(settings)
    for index, peer in enumerate([None, ("", 0), ("unix:", 0), ("unknown-A", 0), ("unknown-B", 0)]):
        async with client_for(app, peer) as client:
            r = await password_attempt(client)
            assert r.status_code == (429 if index == 4 else 401)
    with app.state.db.connect() as connection:
        row = connection.execute("SELECT * FROM login_attempts").fetchone()
        assert row["ip_address"] == "unknown"
        assert connection.execute("SELECT COUNT(*) FROM login_attempts").fetchone()[0] == 1
    async with client_for(app) as valid_ip:
        assert (await password_attempt(valid_ip, "test-password")).status_code == 200


@pytest.mark.anyio
async def test_expired_ip_records_removed_without_shortening_active_lockout(settings, clock):
    app = create_app(settings)
    async with client_for(app) as first:
        assert (await password_attempt(first)).status_code == 401
    clock[0] += 800
    async with client_for(app, ("192.0.2.20", 12345)) as locked:
        for _ in range(5):
            await password_attempt(locked)
    clock[0] += 100
    async with client_for(app, ("192.0.2.30", 12345)) as third:
        assert (await password_attempt(third)).status_code == 401
    with app.state.db.connect() as connection:
        assert {r[0] for r in connection.execute("SELECT ip_address FROM login_attempts")} == {
            "192.0.2.20", "192.0.2.30",
        }
    async with client_for(app, ("192.0.2.20", 12345)) as locked:
        r = await password_attempt(locked, "test-password")
        assert r.status_code == 429
        assert r.headers["retry-after"] == "800"
    clock[0] += 800
    async with client_for(app) as first:
        assert (await password_attempt(first, "test-password")).status_code == 200
    with app.state.db.connect() as connection:
        assert [r[0] for r in connection.execute("SELECT ip_address FROM login_attempts")] == ["192.0.2.30"]


@pytest.mark.anyio
async def test_untrusted_proxy_headers_cannot_change_source_ip(settings, clock):
    app = create_app(settings)
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts=["10.0.0.10"])
    async with client_for(wrapped, ("198.51.100.10", 12345)) as attacker:
        for index in range(5):
            r = await attacker.post("/api/session", json={"password": "wrong"}, headers={
                "X-Forwarded-For": f"192.0.2.{index + 1}",
                "X-Real-IP": f"192.0.2.{index + 10}",
                "Forwarded": f"for=192.0.2.{index + 20}",
            })
            assert r.status_code == (429 if index == 4 else 401)
    with app.state.db.connect() as connection:
        assert [r[0] for r in connection.execute("SELECT ip_address FROM login_attempts")] == ["198.51.100.10"]


@pytest.mark.anyio
async def test_trusted_proxy_separates_ips_and_rejects_spoofed_prefix(settings, clock):
    app = create_app(settings)
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts=["10.0.0.10", "10.0.0.11"])
    async with client_for(wrapped, ("10.0.0.10", 12345)) as proxy:
        for _ in range(4):
            r = await proxy.post("/api/session", json={"password": "wrong"}, headers={
                "X-Forwarded-For": "192.0.2.10, 10.0.0.11",
            })
            assert r.status_code == 401
        # A trusted proxy appends the real peer. The fake leftmost IP must not win.
        r = await proxy.post("/api/session", json={"password": "wrong"}, headers={
            "X-Forwarded-For": "198.51.100.99, 192.0.2.10, 10.0.0.11",
        })
        assert r.status_code == 429
        values = await consent_values(proxy)
        owner_headers = {"X-Forwarded-For": "192.0.2.20, 10.0.0.11"}
        assert (await proxy.post("/api/session", json={"password": "test-password"}, headers=owner_headers)).status_code == 200
        granted = await proxy.post("/oauth/authorize", data={**values, "password": "test-password"}, headers=owner_headers)
        assert granted.status_code == 303
        blocked = await proxy.post("/oauth/authorize", data={**values, "password": "test-password"}, headers={"X-Forwarded-For": "192.0.2.10"})
        assert blocked.status_code == 429
    with app.state.db.connect() as connection:
        assert [r[0] for r in connection.execute("SELECT ip_address FROM login_attempts")] == ["192.0.2.10"]


@pytest.mark.anyio
async def test_legacy_global_lock_migration_preserves_notes_and_credentials(settings, clock):
    app = create_app(settings)
    db = app.state.db
    note = db.create_note("private-migration-test.md", "# Keep my content")
    session = db.create_session(3600)
    before = db.list_tree()
    with db.connect(write=True) as connection:
        connection.execute("DROP TABLE login_attempts")
        connection.execute("""CREATE TABLE login_attempts (
            id INTEGER PRIMARY KEY CHECK (id = 1), failed_attempts INTEGER NOT NULL,
            window_started_at INTEGER NOT NULL, locked_until INTEGER NOT NULL
        )""")
        connection.execute("INSERT INTO login_attempts VALUES (1, 5, ?, ?)", (clock[0], clock[0] + 900))
    migrated = create_app(settings)
    assert migrated.state.db.list_tree() == before
    assert migrated.state.db.get_note(note["id"])["content"] == "# Keep my content"
    assert migrated.state.db.valid_session(session)
    async with client_for(migrated) as client:
        assert (await password_attempt(client, "test-password")).status_code == 200
        for _ in range(5):
            await password_attempt(client)
    # Re-running initialization must preserve new per-IP lockouts.
    async with client_for(create_app(settings)) as restarted:
        assert (await password_attempt(restarted, "test-password")).status_code == 429
    with migrated.state.db.connect() as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
