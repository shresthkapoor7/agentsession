import unicodedata
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_BIGINT = 9_223_372_036_854_775_807
CapabilityToken = Annotated[str, Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")]


class Provider(StrEnum):
    CODEX = "codex"
    CLAUDE = "claude"


class Visibility(StrEnum):
    PUBLIC = "public"
    PASSWORD = "password"


class ShareMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    processed_tokens: int = Field(default=0, ge=0, le=MAX_BIGINT)
    cached_tokens: int = Field(default=0, ge=0, le=MAX_BIGINT)
    generated_tokens: int = Field(default=0, ge=0, le=MAX_BIGINT)
    reasoning_tokens: int = Field(default=0, ge=0, le=MAX_BIGINT)
    tasks: int = Field(default=0, ge=0, le=2_147_483_647)
    tools: int = Field(default=0, ge=0, le=2_147_483_647)
    patches: int = Field(default=0, ge=0, le=2_147_483_647)
    models: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("models")
    @classmethod
    def validate_models(cls, models: list[str]) -> list[str]:
        normalized = []
        for model in models:
            value = unicodedata.normalize("NFKC", model).strip()
            if (
                not value
                or len(value) > 80
                or any(unicodedata.category(c).startswith("C") for c in value)
            ):
                raise ValueError("model names must be 1-80 printable characters")
            normalized.append(value)
        return normalized


class PublishIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(min_length=1, max_length=80)
    provider: Provider
    visibility: Visibility
    password: str | None = Field(default=None, min_length=8, max_length=200)
    schema_version: int = Field(ge=1, le=32_767)
    compressed_bytes: int = Field(ge=1, le=MAX_UPLOAD_BYTES)
    metrics: ShareMetrics = Field(default_factory=ShareMetrics)

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, display_name: str) -> str:
        normalized = " ".join(unicodedata.normalize("NFKC", display_name).split())
        if (
            not normalized
            or len(normalized) > 80
            or any(unicodedata.category(c).startswith("C") for c in normalized)
        ):
            raise ValueError("display name contains unsupported characters")
        return normalized

    @model_validator(mode="after")
    def password_matches_visibility(self) -> "PublishIntentRequest":
        if self.visibility == Visibility.PASSWORD and self.password is None:
            raise ValueError("password is required for password-protected shares")
        if self.visibility == Visibility.PUBLIC and self.password is not None:
            raise ValueError("password is only accepted for password-protected shares")
        return self


class PublishIntentResponse(BaseModel):
    publish_intent_id: str
    upload_url: str
    upload_method: str = "PUT"
    upload_headers: dict[str, str]
    intent_expires_at: datetime
    share_expires_at: datetime
    view_token: str
    manage_token: str


class CompletePublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    view_token: CapabilityToken
    manage_token: CapabilityToken


class CompletePublishResponse(BaseModel):
    status: str = "ready"
    share_url: str
    manage_url: str
    expires_at: datetime


class ShareMetadata(BaseModel):
    display_name: str
    provider: Provider
    visibility: Visibility
    expires_at: datetime
    schema_version: int
    compressed_bytes: int
    metrics: ShareMetrics


class ShareResponse(BaseModel):
    metadata: ShareMetadata
    requires_password: bool
    download_url: str | None = None
    download_expires_in: int | None = None


class UnlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=1, max_length=200)


class RevokeResponse(BaseModel):
    status: str = "revoked"
    cleanup_pending: bool


class CleanupResponse(BaseModel):
    claimed: int
    deleted: int
    pending: int
    rate_limit_buckets_purged: int


class ShareRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    share_id: str
    display_name: str
    provider: Provider
    visibility: Visibility
    password_hash: str | None
    storage_path: str
    expires_at: datetime
    schema_version: int
    processed_tokens: int
    cached_tokens: int
    generated_tokens: int
    reasoning_tokens: int
    tasks_count: int
    tools_count: int
    patches_count: int
    model_summary: list[str]
    compressed_bytes: int

    def public_metadata(self) -> ShareMetadata:
        return ShareMetadata(
            display_name=self.display_name,
            provider=self.provider,
            visibility=self.visibility,
            expires_at=self.expires_at,
            schema_version=self.schema_version,
            compressed_bytes=self.compressed_bytes,
            metrics=ShareMetrics(
                processed_tokens=self.processed_tokens,
                cached_tokens=self.cached_tokens,
                generated_tokens=self.generated_tokens,
                reasoning_tokens=self.reasoning_tokens,
                tasks=self.tasks_count,
                tools=self.tools_count,
                patches=self.patches_count,
                models=self.model_summary,
            ),
        )
