import asyncio
import sys

import httpx

from app.config import get_settings


async def run_cleanup() -> int:
    settings = get_settings()
    token = settings.internal_cleanup_token.get_secret_value()
    if not token:
        print("INTERNAL_CLEANUP_TOKEN is required", file=sys.stderr)
        return 2

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as client:
            response = await client.post(
                f"{settings.backend_base_url}/v1/internal/cleanup-expired",
                headers={"X-Internal-Token": token},
            )
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        print(f"Cleanup request failed: {type(exc).__name__}", file=sys.stderr)
        return 1

    print(
        "Cleanup complete: "
        f"claimed={result.get('claimed', 0)} "
        f"deleted={result.get('deleted', 0)} "
        f"pending={result.get('pending', 0)}"
    )
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(run_cleanup()))


if __name__ == "__main__":
    main()
