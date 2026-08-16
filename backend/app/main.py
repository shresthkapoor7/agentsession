import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import router
from app.config import get_settings
from app.supabase import SupabaseGateway, UpstreamError


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    application.state.supabase = None
    if settings.backend_configured:
        application.state.supabase = SupabaseGateway(
            settings.supabase_url,
            settings.supabase_service_role_key.get_secret_value(),
            settings.supabase_storage_bucket,
        )
    try:
        yield
    finally:
        if application.state.supabase is not None:
            await application.state.supabase.close()


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())
    application = FastAPI(
        title="agentsession API",
        version="0.1.0",
        docs_url="/docs" if settings.app_env != "production" else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Internal-Token"],
        max_age=600,
    )
    application.include_router(router)

    @application.exception_handler(UpstreamError)
    async def upstream_error(_: Request, __: UpstreamError) -> JSONResponse:
        return JSONResponse(
            status_code=502,
            content={"detail": "Storage or database service unavailable"},
        )

    @application.get("/health", include_in_schema=False)
    async def health() -> dict[str, str | bool]:
        return {
            "status": "ok",
            "service": settings.app_name,
            "configured": settings.backend_configured,
        }

    return application


app = create_app()
