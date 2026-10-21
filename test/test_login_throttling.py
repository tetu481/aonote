from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import httpx
import pytest

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


def client_for(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


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
async def test_browser_and_oauth_share_budget_across_clients(settings, clock):
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
        return login.check_login(db, settings, "wrong")

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
