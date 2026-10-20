from pathlib import Path

import httpx
import pytest

from aonote.application import create_app
from aonote.config import Settings


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.parametrize("value,expected", [
    (None, 1), ("1", 1), ("2", 2), (" 24 ", 24),
    ("", 1), ("0", 1), ("-1", 1), ("0.5", 1), ("invalid", 1),
])
def test_workspace_session_hours_from_environment(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("AONOTE_WORKSPACE_SESSION_HOURS", raising=False)
    else:
        monkeypatch.setenv("AONOTE_WORKSPACE_SESSION_HOURS", value)
    settings = Settings.from_env()
    assert settings.workspace_session_hours == expected
    assert settings.session_ttl == 604800


@pytest.mark.anyio
@pytest.mark.parametrize("hours", [1, 2])
async def test_workspace_session_hours_reaches_browser_status(tmp_path: Path, monkeypatch, hours):
    monkeypatch.setenv("AONOTE_WORKSPACE_SESSION_HOURS", str(hours))
    monkeypatch.setenv("AONOTE_DATABASE", str(tmp_path / "workspace-session.sqlite3"))
    monkeypatch.setenv("AONOTE_DEV_BYPASS_AUTH", "true")
    app = create_app(Settings.from_env())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.get("/api/status")
    assert response.status_code == 200
    assert response.json()["workspace_session_hours"] == hours
