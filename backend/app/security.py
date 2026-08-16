import hashlib
import hmac
import ipaddress
import re
import secrets

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Request

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
PASSWORD_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65_536,
    parallelism=4,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)


def generate_capability() -> str:
    return secrets.token_urlsafe(32)


def valid_capability(token: str) -> bool:
    return TOKEN_PATTERN.fullmatch(token) is not None


def hash_identifier(value: str, purpose: str, pepper: str) -> str:
    message = f"agentsession:{purpose}:{value}".encode()
    return hmac.new(pepper.encode(), message, hashlib.sha256).hexdigest()


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return PASSWORD_HASHER.verify(password_hash, password)
    except (InvalidHashError, VerifyMismatchError, VerificationError):
        return False


def client_ip(request: Request, trusted_proxy_hops: int) -> str:
    peer = request.client.host if request.client else "0.0.0.0"
    forwarded = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",")]
    forwarded = [part for part in forwarded if part]

    candidate = peer
    if trusted_proxy_hops and len(forwarded) >= trusted_proxy_hops:
        candidate = forwarded[-trusted_proxy_hops]

    try:
        return ipaddress.ip_address(candidate).compressed
    except ValueError:
        try:
            return ipaddress.ip_address(peer).compressed
        except ValueError:
            return "0.0.0.0"
