"""Mediqo API entrypoint.

FastAPI application factory wiring together:
    - configuration (app/config.py)
    - PostgreSQL session management (app/database.py)
    - HTTP routes (app/routes/*)

Run from the backend/ directory:
    uvicorn app.main:app --reload --port 8000
"""

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.config import settings
from app.routes import analyze, doctors, health, location, matching

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("mediqo")


def create_app() -> FastAPI:
    """Build the FastAPI application."""
    application = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        summary="Find the right doctor, wherever you are.",
        description=(
            "Mediqo MVP backend. A user provides their location and a "
            "plain-language description of their medical problem; Mediqo "
            "identifies the relevant medical specialty, searches the doctor "
            "database, and ranks nearby doctors by suitability. "
            "**Not a diagnostic system.**"
        ),
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(health.router)
    application.include_router(doctors.router)
    application.include_router(analyze.router)
    application.include_router(location.router)
    application.include_router(matching.router)

    @application.exception_handler(SQLAlchemyError)
    async def database_error_handler(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        """Never leak PostgreSQL/SQLAlchemy details to clients; log server-side."""
        logger.exception("Database error while handling %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=503,
            content={"detail": "Database temporarily unavailable. Please try again."},
        )

    logger.info("%s API ready", settings.app_name)
    return application


app = create_app()
