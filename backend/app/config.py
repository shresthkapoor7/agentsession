from functools import cached_property, lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "agentsession-api"
    log_level: str = "INFO"

    supabase_url: str = "https://nlmpzqrzmkwrsdovnowp.supabase.co"
    supabase_service_role_key: SecretStr = SecretStr("")
    supabase_storage_bucket: str = "session-transcripts"

    capability_hash_pepper: SecretStr = SecretStr("")
    internal_cleanup_token: SecretStr = SecretStr("")
    cors_origins: str = Field(
        default="http://localhost:3000,http://127.0.0.1:3000",
        description="Comma-separated exact browser origins",
    )

    @cached_property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def backend_configured(self) -> bool:
        return bool(
            self.supabase_service_role_key.get_secret_value()
            and self.capability_hash_pepper.get_secret_value()
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
