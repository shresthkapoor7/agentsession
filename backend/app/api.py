import logging
import secrets
import uuid
from typing import Annotated, Any

from anyio import to_thread
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from app.config import Settings, get_settings
from app.models import (
    CleanupResponse,
    CompletePublishRequest,
    CompletePublishResponse,
    PublishIntentRequest,
    PublishIntentResponse,
    RevokeResponse,
    ShareRecord,
    ShareResponse,
    UnlockRequest,
    Visibility,
)
from app.security import (
    client_ip,
    generate_capability,
    hash_identifier,
    hash_password,
    valid_capability,
    verify_password,
)
from app.supabase import SupabaseGateway, UpstreamError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1")


def gateway_from_request(request: Request) -> SupabaseGateway:
    gateway = getattr(request.app.state, "supabase", None)
    if gateway is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not configured"
        )
    return gateway


Gateway = Annotated[SupabaseGateway, Depends(gateway_from_request)]
AppSettings = Annotated[Settings, Depends(get_settings)]


def request_ip_hash(request: Request, settings: Settings) -> str:
    ip = client_ip(request, settings.trusted_proxy_hops)
    return hash_identifier(ip, "ip", settings.capability_hash_pepper.get_secret_value())


async def enforce_limit(
    gateway: SupabaseGateway,
    *,
    scope: str,
    subject_hash: str,
    limit: int,
    window_seconds: int,
    cost: int = 1,
) -> None:
    allowed = await gateway.rpc(
        "consume_rate_limit",
        {
            "p_scope": scope,
            "p_subject_hash": subject_hash,
            "p_limit": limit,
            "p_window_seconds": window_seconds,
            "p_cost": cost,
        },
    )
    if allowed is not True:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(window_seconds)},
        )


def first_row(value: Any) -> dict[str, Any] | None:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return None


def response_rows(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


async def load_share(gateway: SupabaseGateway, view_token: str, pepper: str) -> ShareRecord:
    if not valid_capability(view_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    row = first_row(
        await gateway.rpc(
            "get_share_by_view_hash",
            {"p_view_token_hash": hash_identifier(view_token, "view", pepper)},
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    return ShareRecord.model_validate(row)


async def signed_share_response(gateway: SupabaseGateway, share: ShareRecord) -> ShareResponse:
    return ShareResponse(
        metadata=share.public_metadata(),
        requires_password=False,
        download_url=await gateway.create_signed_download_url(share.storage_path, 60),
        download_expires_in=60,
    )


@router.post(
    "/publish-intents",
    response_model=PublishIntentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_publish_intent(
    body: PublishIntentRequest,
    request: Request,
    gateway: Gateway,
    settings: AppSettings,
) -> PublishIntentResponse:
    ip_hash = request_ip_hash(request, settings)
    await enforce_limit(
        gateway,
        scope="publish-hour",
        subject_hash=ip_hash,
        limit=5,
        window_seconds=3600,
    )
    await enforce_limit(
        gateway,
        scope="publish-bytes-day",
        subject_hash=ip_hash,
        limit=settings.daily_upload_bytes_per_ip,
        window_seconds=86_400,
        cost=body.compressed_bytes,
    )

    view_token = generate_capability()
    manage_token = generate_capability()
    object_id = uuid.uuid4()
    storage_path = f"shares/{object_id.hex[:2]}/{object_id}.bin"
    pepper = settings.capability_hash_pepper.get_secret_value()
    password_digest = None
    if body.password is not None:
        password_digest = await to_thread.run_sync(hash_password, body.password)

    rows = await gateway.rpc(
        "create_publish_intent",
        {
            "p_view_token_hash": hash_identifier(view_token, "view", pepper),
            "p_manage_token_hash": hash_identifier(manage_token, "manage", pepper),
            "p_display_name": body.display_name,
            "p_provider": body.provider.value,
            "p_visibility": body.visibility.value,
            "p_password_hash": password_digest,
            "p_storage_path": storage_path,
            "p_schema_version": body.schema_version,
            "p_expected_compressed_bytes": body.compressed_bytes,
            "p_request_ip_hash": ip_hash,
            "p_metrics": body.metrics.model_dump(),
        },
    )
    row = first_row(rows)
    if row is None:
        raise UpstreamError("Supabase did not create a publish intent")

    try:
        upload_url = await gateway.create_signed_upload_url(storage_path)
    except UpstreamError:
        await gateway.rpc(
            "claim_share_revocation",
            {"p_manage_token_hash": hash_identifier(manage_token, "manage", pepper)},
        )
        await gateway.rpc("delete_share_metadata", {"p_share_id": row["share_id"]})
        raise

    return PublishIntentResponse(
        publish_intent_id=row["intent_id"],
        upload_url=upload_url,
        upload_headers={"content-type": "application/octet-stream", "x-upsert": "false"},
        intent_expires_at=row["intent_expires_at"],
        share_expires_at=row["share_expires_at"],
        view_token=view_token,
        manage_token=manage_token,
    )


@router.post(
    "/publish-intents/{publish_intent_id}/complete",
    response_model=CompletePublishResponse,
)
async def complete_publish_intent(
    publish_intent_id: uuid.UUID,
    body: CompletePublishRequest,
    request: Request,
    gateway: Gateway,
    settings: AppSettings,
) -> CompletePublishResponse:
    ip_hash = request_ip_hash(request, settings)
    await enforce_limit(
        gateway,
        scope="share-minute",
        subject_hash=ip_hash,
        limit=60,
        window_seconds=60,
    )
    pepper = settings.capability_hash_pepper.get_secret_value()
    # The generated object path is not accepted from the browser. Resolve it via
    # the still-uploading share record using the view capability.
    row = first_row(
        await gateway.rpc(
            "get_uploading_share",
            {
                "p_intent_id": str(publish_intent_id),
                "p_view_token_hash": hash_identifier(body.view_token, "view", pepper),
                "p_manage_token_hash": hash_identifier(body.manage_token, "manage", pepper),
            },
        )
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Publish intent is unavailable"
        )
    storage_path = row["storage_path"]
    actual_size = await gateway.object_size(storage_path)

    completed = first_row(
        await gateway.rpc(
            "complete_publish_intent",
            {
                "p_intent_id": str(publish_intent_id),
                "p_view_token_hash": hash_identifier(body.view_token, "view", pepper),
                "p_manage_token_hash": hash_identifier(body.manage_token, "manage", pepper),
                "p_actual_compressed_bytes": actual_size,
            },
        )
    )
    if completed is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Upload size does not match or publish intent expired",
        )

    return CompletePublishResponse(
        share_url=f"{settings.frontend_base_url}/share/{body.view_token}",
        manage_url=f"{settings.frontend_base_url}/manage/{body.manage_token}",
        expires_at=completed["expires_at"],
    )


@router.get("/shares/{view_token}", response_model=ShareResponse)
async def get_share(
    view_token: str,
    request: Request,
    gateway: Gateway,
    settings: AppSettings,
) -> ShareResponse:
    await enforce_limit(
        gateway,
        scope="share-minute",
        subject_hash=request_ip_hash(request, settings),
        limit=60,
        window_seconds=60,
    )
    share = await load_share(
        gateway,
        view_token,
        settings.capability_hash_pepper.get_secret_value(),
    )
    if share.visibility == Visibility.PASSWORD:
        return ShareResponse(metadata=share.public_metadata(), requires_password=True)
    return await signed_share_response(gateway, share)


@router.post("/shares/{view_token}/unlock", response_model=ShareResponse)
async def unlock_share(
    view_token: str,
    body: UnlockRequest,
    request: Request,
    gateway: Gateway,
    settings: AppSettings,
) -> ShareResponse:
    pepper = settings.capability_hash_pepper.get_secret_value()
    ip_hash = request_ip_hash(request, settings)
    share_subject = hash_identifier(f"{ip_hash}:{view_token}", "password-attempt", pepper)
    await enforce_limit(
        gateway,
        scope="password-attempt",
        subject_hash=share_subject,
        limit=10,
        window_seconds=900,
    )
    share = await load_share(gateway, view_token, pepper)
    if share.visibility != Visibility.PASSWORD or share.password_hash is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    password_valid = await to_thread.run_sync(verify_password, share.password_hash, body.password)
    if not password_valid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")
    return await signed_share_response(gateway, share)


@router.post("/manage/{manage_token}/revoke", response_model=RevokeResponse)
async def revoke_share(
    manage_token: str,
    request: Request,
    gateway: Gateway,
    settings: AppSettings,
) -> RevokeResponse:
    await enforce_limit(
        gateway,
        scope="share-minute",
        subject_hash=request_ip_hash(request, settings),
        limit=60,
        window_seconds=60,
    )
    if not valid_capability(manage_token):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Management link not found"
        )
    row = first_row(
        await gateway.rpc(
            "claim_share_revocation",
            {
                "p_manage_token_hash": hash_identifier(
                    manage_token,
                    "manage",
                    settings.capability_hash_pepper.get_secret_value(),
                )
            },
        )
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Management link not found"
        )

    cleanup_pending = True
    try:
        await gateway.delete_objects([row["storage_path"]])
        await gateway.rpc("delete_share_metadata", {"p_share_id": row["share_id"]})
        cleanup_pending = False
    except UpstreamError:
        logger.warning("Revoked share object cleanup deferred")
    return RevokeResponse(cleanup_pending=cleanup_pending)


@router.post("/internal/cleanup-expired", response_model=CleanupResponse)
async def cleanup_expired(
    gateway: Gateway,
    settings: AppSettings,
    x_internal_token: Annotated[str | None, Header()] = None,
) -> CleanupResponse:
    expected = settings.internal_cleanup_token.get_secret_value()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Cleanup not configured"
        )
    if x_internal_token is None or not secrets.compare_digest(
        x_internal_token.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    claimed = response_rows(await gateway.rpc("claim_expired_shares", {"p_limit": 100}))
    pending = response_rows(await gateway.rpc("list_pending_deletions", {"p_limit": 100}))
    rows_by_id = {
        row["share_id"]: row
        for row in [*claimed, *pending]
        if isinstance(row.get("share_id"), str) and isinstance(row.get("storage_path"), str)
    }
    deleted = 0
    for row in rows_by_id.values():
        try:
            await gateway.delete_objects([row["storage_path"]])
            removed = await gateway.rpc("delete_share_metadata", {"p_share_id": row["share_id"]})
            if removed is True:
                deleted += 1
        except UpstreamError:
            logger.warning("Expired share object cleanup deferred")

    purged = await gateway.rpc("purge_old_rate_limits")
    return CleanupResponse(
        claimed=len(claimed),
        deleted=deleted,
        pending=max(len(rows_by_id) - deleted, 0),
        rate_limit_buckets_purged=int(purged or 0),
    )
