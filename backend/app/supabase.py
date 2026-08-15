from typing import Any
from urllib.parse import quote

import httpx


class UpstreamError(RuntimeError):
    """Supabase rejected or could not complete a server-side operation."""


class SupabaseGateway:
    def __init__(self, url: str, service_role_key: str, bucket: str) -> None:
        self._base_url = url.rstrip("/")
        self._storage_url = f"{self._base_url}/storage/v1"
        self._bucket = bucket
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(15, connect=5),
            headers={
                "apikey": service_role_key,
                "authorization": f"Bearer {service_role_key}",
            },
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, url, **kwargs)
            response.raise_for_status()
            return response
        except (httpx.HTTPError, ValueError) as exc:
            raise UpstreamError("Supabase operation failed") from exc

    async def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        response = await self._request(
            "POST",
            f"{self._base_url}/rest/v1/rpc/{quote(name, safe='')}",
            json=payload or {},
            headers={"content-type": "application/json"},
        )
        return response.json()

    def _storage_path(self, path: str) -> str:
        return quote(f"{self._bucket}/{path}", safe="/")

    async def create_signed_upload_url(self, path: str) -> str:
        response = await self._request(
            "POST",
            f"{self._storage_url}/object/upload/sign/{self._storage_path(path)}",
            json={},
            headers={"content-type": "application/json", "x-upsert": "false"},
        )
        relative_url = response.json().get("url")
        if not isinstance(relative_url, str) or not relative_url.startswith("/"):
            raise UpstreamError("Supabase returned an invalid upload URL")
        return f"{self._storage_url}{relative_url}"

    async def object_size(self, path: str) -> int:
        response = await self._request(
            "GET",
            f"{self._storage_url}/object/info/{self._storage_path(path)}",
        )
        data = response.json()
        size = data.get("size")
        if size is None and isinstance(data.get("metadata"), dict):
            size = data["metadata"].get("size")
        try:
            parsed_size = int(size)
        except (TypeError, ValueError) as exc:
            raise UpstreamError("Supabase returned invalid object metadata") from exc
        if parsed_size < 1:
            raise UpstreamError("Supabase returned an empty object")
        return parsed_size

    async def create_signed_download_url(self, path: str, expires_in: int = 60) -> str:
        response = await self._request(
            "POST",
            f"{self._storage_url}/object/sign/{self._storage_path(path)}",
            json={"expiresIn": expires_in},
            headers={"content-type": "application/json"},
        )
        relative_url = response.json().get("signedURL")
        if not isinstance(relative_url, str) or not relative_url.startswith("/"):
            raise UpstreamError("Supabase returned an invalid download URL")
        return f"{self._storage_url}{relative_url}"

    async def delete_objects(self, paths: list[str]) -> None:
        if not paths:
            return
        await self._request(
            "DELETE",
            f"{self._storage_url}/object/{quote(self._bucket, safe='')}",
            json={"prefixes": paths},
            headers={"content-type": "application/json"},
        )
