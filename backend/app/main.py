"""Mediqo API entrypoint.

FastAPI application factory wiring together:
    - configuration (app/config.py)
    - PostgreSQL session management (app/database.py)
    - HTTP routes (app/routes/*)

Run from the backend/ directory:
    uvicorn app.main:app --reload --port 8000

On startup the database schema is ensured and the demo dataset is seeded
(both idempotent — see `initialize_database` below).
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.config import settings
from app.database import SessionLocal, ensure_schema
from app.routes import analyze, doctors, health, location, matching
from app.seed import seed_demo_data

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("mediqo")


def initialize_database() -> None:
    """Ensure the schema exists, then seed demo data once (both idempotent).

    Fresh production databases (e.g. a newly provisioned Render PostgreSQL)
    contain no tables; without this, every endpoint fails with
    `relation "doctors" does not exist`. `create_all` only creates missing
    tables (never alters or drops), and `seed_demo_data` exits early when
    demo data is already present, so restarting is always safe and no
    existing data is ever removed.
    """
    ensure_schema()
    session = SessionLocal()
    try:
        seeded = seed_demo_data(session)
    finally:
        session.close()
    if seeded:
        logger.info(
            "Seeded demo dataset: %s doctors, %s reviews",
            seeded["doctors"],
            seeded["reviews"],
        )
    else:
        logger.info("Demo data already present — seed skipped.")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Run database initialization once per process before serving traffic."""
    initialize_database()
    yield


def create_app() -> FastAPI:
    """Build the FastAPI application."""
    application = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
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
