from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import create_app
from app.security import hash_password

TOKEN = "a" * 43
MANAGE_TOKEN = "b" * 43
NOW = datetime.now(UTC)


class FakeGateway:
    def __init__(self, *, visibility: str = "public") -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.deleted: list[list[str]] = []
        self.visibility = visibility
        self.share_id = str(uuid4())
        self.storage_path = "shares/ab/test-share.bin"

    async def rpc(self, name: str, payload: dict[str, object] | None = None) -> object:
        payload = payload or {}
        self.calls.append((name, payload))
        if name == "consume_rate_limit":
            return True
        if name == "create_publish_intent":
            return [
                {
                    "intent_id": str(uuid4()),
                    "share_id": self.share_id,
                    "intent_expires_at": (NOW + timedelta(minutes=10)).isoformat(),
                    "share_expires_at": (NOW + timedelta(days=21)).isoformat(),
                }
            ]
        if name == "get_uploading_share":
            return [{"storage_path": self.storage_path}]
        if name == "complete_publish_intent":
            return [{"expires_at": (NOW + timedelta(days=21)).isoformat()}]
        if name == "get_share_by_view_hash":
            return [
                {
                    "share_id": self.share_id,
                    "display_name": "Ada",
                    "provider": "codex",
                    "visibility": self.visibility,
                    "password_hash": hash_password("correct-password")
                    if self.visibility == "password"
                    else None,
                    "storage_path": self.storage_path,
                    "expires_at": (NOW + timedelta(days=21)).isoformat(),
                    "schema_version": 1,
                    "processed_tokens": 120,
                    "cached_tokens": 100,
                    "generated_tokens": 20,
                    "reasoning_tokens": 5,
                    "tasks_count": 2,
                    "tools_count": 3,
                    "patches_count": 1,
                    "model_summary": ["gpt-5.6-terra"],
                    "compressed_bytes": 256,
                }
            ]
        if name == "claim_share_revocation":
            return [{"share_id": self.share_id, "storage_path": self.storage_path}]
        if name == "delete_share_metadata":
            return True
        raise AssertionError(f"Unexpected RPC: {name}")

    async def close(self) -> None:
        return None

    async def create_signed_upload_url(self, path: str) -> str:
        self.storage_path = path
        return "https://storage.example/upload"

    async def create_signed_download_url(self, path: str, expires_in: int) -> str:
        assert path == self.storage_path
        assert expires_in == 60
        return "https://storage.example/download"

    async def object_size(self, path: str) -> int:
        assert path == self.storage_path
        return 256

    async def delete_objects(self, paths: list[str]) -> None:
        self.deleted.append(paths)


def settings() -> Settings:
    return Settings(
        _env_file=None,
        capability_hash_pepper="test-pepper",
        frontend_public_url="https://agentsession.example",
        internal_cleanup_token="test-cleanup-token",
        supabase_service_role_key="test-service-key",
    )


def client_for(gateway: FakeGateway) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_settings] = settings
    client = TestClient(app)
    client.__enter__()
    app.state.supabase = gateway
    return client


def close_client(client: TestClient) -> None:
    client.__exit__(None, None, None)


def test_publish_intent_and_completion_return_capability_links() -> None:
    gateway = FakeGateway()
    client = client_for(gateway)
    try:
        intent = client.post(
            "/v1/publish-intents",
            json={
                "display_name": "Ada",
                "provider": "codex",
                "visibility": "public",
                "schema_version": 1,
                "compressed_bytes": 256,
                "metrics": {"processed_tokens": 120, "models": ["gpt-5.6-terra"]},
            },
        )

        assert intent.status_code == 201
        body = intent.json()
        assert body["upload_url"] == "https://storage.example/upload"
        assert len(body["view_token"]) == 43
        assert len(body["manage_token"]) == 43
        assert body["upload_headers"] == {
            "content-type": "application/octet-stream",
            "x-upsert": "false",
        }
        create_payload = next(
            payload for name, payload in gateway.calls if name == "create_publish_intent"
        )
        assert create_payload["p_display_name"] == "Ada"
        assert "p_storage_path" in create_payload

        complete = client.post(
            f"/v1/publish-intents/{body['publish_intent_id']}/complete",
            json={"view_token": body["view_token"], "manage_token": body["manage_token"]},
        )

        assert complete.status_code == 200
        assert complete.json()["share_url"] == f"https://agentsession.example/share/{body['view_token']}"
        assert complete.json()["manage_url"] == f"https://agentsession.example/manage/{body['manage_token']}"
    finally:
        close_client(client)


def test_password_share_hides_download_until_the_password_is_valid() -> None:
    gateway = FakeGateway(visibility="password")
    client = client_for(gateway)
    try:
        protected = client.get(f"/v1/shares/{TOKEN}")
        wrong_password = client.post(
            f"/v1/shares/{TOKEN}/unlock", json={"password": "wrong-password"}
        )
        unlocked = client.post(f"/v1/shares/{TOKEN}/unlock", json={"password": "correct-password"})

        assert protected.status_code == 200
        assert protected.json()["requires_password"] is True
        assert protected.json()["download_url"] is None
        assert protected.json()["metadata"]["display_name"] == "Ada"
        assert wrong_password.status_code == 401
        assert unlocked.status_code == 200
        assert unlocked.json()["download_url"] == "https://storage.example/download"
    finally:
        close_client(client)


def test_revoke_deletes_the_encrypted_object_and_metadata() -> None:
    gateway = FakeGateway()
    client = client_for(gateway)
    try:
        response = client.post(f"/v1/manage/{MANAGE_TOKEN}/revoke")

        assert response.status_code == 200
        assert response.json() == {"status": "revoked", "cleanup_pending": False}
        assert gateway.deleted == [[gateway.storage_path]]
        assert "delete_share_metadata" in [name for name, _ in gateway.calls]
    finally:
        close_client(client)


def test_public_intent_rejects_a_password() -> None:
    gateway = FakeGateway()
    client = client_for(gateway)
    try:
        response = client.post(
            "/v1/publish-intents",
            json={
                "display_name": "Ada",
                "provider": "codex",
                "visibility": "public",
                "password": "correct-password",
                "schema_version": 1,
                "compressed_bytes": 256,
            },
        )

        assert response.status_code == 422
    finally:
        close_client(client)
