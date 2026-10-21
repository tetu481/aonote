"""Persistent, per-IP password throttling shared by browser and OAuth login."""
from dataclasses import dataclass
from ipaddress import IPv6Address, ip_address

from .config import Settings
from .db import Database
from .security import now_ts, verify_password


LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCKOUT_SECONDS = 15 * 60


@dataclass(frozen=True)
class LoginResult:
    authenticated: bool
    retry_after: int = 0


def _client_ip(client_host: str | None) -> str:
    # Use the ASGI peer, already processed by Uvicorn's trusted proxy handling.
    # Never read raw X-Forwarded-For / X-Real-IP headers here.
    try:
        address = ip_address((client_host or "").split("%", 1)[0])
    except ValueError:
        # Unknown/non-IP peers share a bounded fallback instead of creating
        # arbitrary keys or bypassing throttling (e.g. UNIX socket clients).
        return "unknown"
    if isinstance(address, IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address)


def check_login(
    db: Database, settings: Settings, password: str, client_host: str | None,
) -> LoginResult:
    client_ip = _client_ip(client_host)
    # Lock BEFORE reading/checking the password so parallel requests and workers
    # share one attempt budget per IP, regardless of browser or OAuth client.
    with db.connect(write=True) as connection:
        now = now_ts()
        # Expired IPs must not accumulate indefinitely. An index keeps cleanup
        # bounded to expired entries; active lockouts retain their full duration.
        connection.execute("DELETE FROM login_attempts WHERE expires_at <= ?", (now,))
        row = connection.execute(
            "SELECT * FROM login_attempts WHERE ip_address = ?", (client_ip,),
        ).fetchone()
        if row and row["locked_until"] > now:
            # Blocked requests must not extend the lockout.
            return LoginResult(False, row["locked_until"] - now)
        if verify_password(password, settings.admin_password):
            connection.execute("DELETE FROM login_attempts WHERE ip_address = ?", (client_ip,))
            return LoginResult(True)
        attempts = (row["failed_attempts"] if row else 0) + 1
        window_started_at = row["window_started_at"] if row else now
        locked_until = now + LOGIN_LOCKOUT_SECONDS if attempts >= settings.login_max_attempts else 0
        expires_at = locked_until or window_started_at + LOGIN_WINDOW_SECONDS
        connection.execute(
            """INSERT INTO login_attempts
                   (ip_address, failed_attempts, window_started_at, locked_until, expires_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(ip_address) DO UPDATE SET
                 failed_attempts = excluded.failed_attempts,
                 window_started_at = excluded.window_started_at,
                 locked_until = excluded.locked_until,
                 expires_at = excluded.expires_at""",
            (client_ip, attempts, window_started_at, locked_until, expires_at),
        )
    # Return only after COMMIT: raising HTTPException inside the transaction
    # would roll back the failure that triggered the lockout.
    return LoginResult(False, LOGIN_LOCKOUT_SECONDS if locked_until else 0)
