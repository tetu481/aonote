"""Shared, persistent password throttling for the single admin account."""
from dataclasses import dataclass

from .config import Settings
from .db import Database
from .security import now_ts, verify_password


LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCKOUT_SECONDS = 15 * 60


@dataclass(frozen=True)
class LoginResult:
    authenticated: bool
    retry_after: int = 0


def check_login(db: Database, settings: Settings, password: str) -> LoginResult:
    # Lock BEFORE reading/checking the password so parallel requests and workers
    # share one attempt budget. No client-controlled IP/header can reset it.
    with db.connect(write=True) as connection:
        now = now_ts()
        row = connection.execute("SELECT * FROM login_attempts WHERE id = 1").fetchone()
        if row and row["locked_until"] > now:
            # Blocked requests must not extend the lockout.
            return LoginResult(False, row["locked_until"] - now)
        if row and (
            row["locked_until"] > 0
            or now - row["window_started_at"] >= LOGIN_WINDOW_SECONDS
        ):
            row = None
        if verify_password(password, settings.admin_password):
            connection.execute("DELETE FROM login_attempts WHERE id = 1")
            return LoginResult(True)
        attempts = (row["failed_attempts"] if row else 0) + 1
        window_started_at = row["window_started_at"] if row else now
        locked_until = now + LOGIN_LOCKOUT_SECONDS if attempts >= settings.login_max_attempts else 0
        connection.execute(
            """INSERT INTO login_attempts (id, failed_attempts, window_started_at, locked_until)
               VALUES (1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 failed_attempts = excluded.failed_attempts,
                 window_started_at = excluded.window_started_at,
                 locked_until = excluded.locked_until""",
            (attempts, window_started_at, locked_until),
        )
    # Return only after COMMIT: raising HTTPException inside the transaction
    # would roll back the failure that triggered the lockout.
    return LoginResult(False, LOGIN_LOCKOUT_SECONDS if locked_until else 0)
