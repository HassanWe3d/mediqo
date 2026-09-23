"""PostgreSQL connection & session management (SQLAlchemy).

The engine is created lazily-safe at import time; it does not open any
connection until first use, so the app can boot even if PostgreSQL is
temporarily unavailable (e.g. during first-time setup).
"""

from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


# connect_timeout is critical: without it, a stopped/unreachable PostgreSQL
# (especially via Docker port-forwarding on Windows) can hang TCP connects
# for 20s+ per resolved address instead of failing fast.
engine = create_engine(
    settings.sqlalchemy_database_url,
    pool_pre_ping=True,   # drop dead connections transparently
    connect_args={"connect_timeout": settings.db_connect_timeout},
    echo=False,           # flip to True to log all SQL during development
)

SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
)


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: yield a session per request, always close it."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database_connection() -> bool:
    """Return True if PostgreSQL is reachable (used by health/status checks)."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001 - any failure means "unreachable"
        return False


def init_db() -> None:
    """Create all tables defined by the ORM models (MVP schema initialization).

    Uses `Base.metadata.create_all()` — appropriate for the MVP. Introduce
    Alembic migrations once the schema needs to evolve in place.
    """
    # Imported here (not at module level) to avoid a circular import:
    # app.models.* import Base from this module.
    from app import models  # noqa: F401  — registers models on Base.metadata

    Base.metadata.create_all(bind=engine)


def ensure_schema() -> None:
    """Idempotent schema initialization for fresh databases (e.g. Render).

    Runs `Base.metadata.create_all()`, which only issues CREATE TABLE for
    tables that do not exist yet — never ALTER or DROP — so it is safe to
    call on every boot against both empty and populated databases.

    (`init_db` previously existed but nothing invoked it, so a freshly
    provisioned production database booted with no tables and every endpoint
    failed with `relation "doctors" does not exist`.)
    """
    init_db()
