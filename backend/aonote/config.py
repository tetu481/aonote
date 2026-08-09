from dataclasses import dataclass
import os
from pathlib import Path


def _as_bool(value: str, default: bool = False) -> bool:
    if value == "":
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _as_positive_int(value: str, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


@dataclass(frozen=True)
class Settings:
    database_path: Path
    base_url: str
    admin_password: str
    dev_bypass_auth: bool
    max_folder_depth: int = 3
    access_token_ttl: int = 3600
    refresh_token_ttl: int = 2592000
    session_ttl: int = 604800

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("AONOTE_ENV", "development")
        default_bypass = environment == "development"
        return cls(
            database_path=Path(os.getenv("AONOTE_DATABASE", "data/aonote.sqlite3")),
            base_url=os.getenv("AONOTE_BASE_URL", "http://localhost:8000").rstrip("/"),
            admin_password=os.getenv("AONOTE_ADMIN_PASSWORD", "aonote-dev"),
            dev_bypass_auth=_as_bool(
                os.getenv("AONOTE_DEV_BYPASS_AUTH", ""), default_bypass
            ),
            max_folder_depth=_as_positive_int(
                os.getenv("AONOTE_MAX_FOLDER_DEPTH", ""), 3
            ),
        )

    @property
    def mcp_resource(self) -> str:
        return f"{self.base_url}/mcp"
