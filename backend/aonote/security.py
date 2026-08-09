import base64
import hashlib
import hmac
import secrets
import time
from typing import Optional


def random_token(size: int = 32) -> str:
    return secrets.token_urlsafe(size)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_password(candidate: str, expected: str) -> bool:
    return hmac.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8"))


def verify_s256(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    calculated = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(calculated, challenge)


def now_ts() -> int:
    return int(time.time())


def bearer_token(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token
