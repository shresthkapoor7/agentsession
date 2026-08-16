from fastapi import Request

from app.security import (
    client_ip,
    generate_capability,
    hash_identifier,
    hash_password,
    valid_capability,
    verify_password,
)


def request_with_headers(headers: list[tuple[bytes, bytes]], host: str = "127.0.0.1") -> Request:
    return Request(
        {
            "type": "http",
            "headers": headers,
            "client": (host, 1234),
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "scheme": "http",
            "server": ("testserver", 80),
        }
    )


def test_capabilities_are_url_safe_and_fixed_length() -> None:
    token = generate_capability()

    assert len(token) == 43
    assert valid_capability(token)
    assert not valid_capability(f"{token}x")
    assert not valid_capability("not a capability")


def test_identifier_hashes_are_scoped_by_purpose() -> None:
    assert hash_identifier("same-value", "view", "pepper") != hash_identifier(
        "same-value", "manage", "pepper"
    )
    assert hash_identifier("same-value", "view", "pepper") == hash_identifier(
        "same-value", "view", "pepper"
    )


def test_client_ip_uses_the_configured_trusted_proxy_hop() -> None:
    request = request_with_headers([(b"x-forwarded-for", b"198.51.100.5, 203.0.113.9")])

    assert client_ip(request, trusted_proxy_hops=1) == "203.0.113.9"
    assert client_ip(request, trusted_proxy_hops=2) == "198.51.100.5"
    assert client_ip(request, trusted_proxy_hops=0) == "127.0.0.1"


def test_client_ip_rejects_an_invalid_forwarded_value() -> None:
    request = request_with_headers([(b"x-forwarded-for", b"not-an-ip")], host="192.0.2.7")

    assert client_ip(request, trusted_proxy_hops=1) == "192.0.2.7"


def test_password_verification_rejects_wrong_and_malformed_hashes() -> None:
    digest = hash_password("correct-password")

    assert verify_password(digest, "correct-password")
    assert not verify_password(digest, "wrong-password")
    assert not verify_password("not-an-argon2-hash", "correct-password")
