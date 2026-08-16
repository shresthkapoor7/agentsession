import asyncio
from typing import Any

import httpx
import pytest

from app.supabase import SupabaseGateway, UpstreamError


class FakeClient:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    async def aclose(self) -> None:
        return None

    async def request(self, *_: Any, **__: Any) -> httpx.Response:
        return self.response


async def gateway_for(response: httpx.Response) -> SupabaseGateway:
    gateway = SupabaseGateway("https://supabase.example", "service-key", "shares")
    await gateway.close()
    gateway._client = FakeClient(response)
    return gateway


def success_response(*, content: bytes | None = None, json: object | None = None) -> httpx.Response:
    return httpx.Response(
        200,
        content=content,
        json=json,
        request=httpx.Request("POST", "https://supabase.example/test"),
    )


def test_storage_responses_must_be_json_objects() -> None:
    async def run() -> None:
        gateway = await gateway_for(success_response(json=[]))
        with pytest.raises(UpstreamError, match="invalid response"):
            await gateway.create_signed_upload_url("shares/test.bin")

    asyncio.run(run())


def test_invalid_rpc_json_stays_inside_the_upstream_error_boundary() -> None:
    async def run() -> None:
        gateway = await gateway_for(success_response(content=b"not-json"))
        with pytest.raises(UpstreamError, match="invalid JSON"):
            await gateway.rpc("example")

    asyncio.run(run())
