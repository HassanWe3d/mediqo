"""Health check endpoints for the Mediqo API."""

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db

router = APIRouter(tags=["Health"])


@router.get("/health")
def health_check() -> dict[str, str]:
    """Report that the API is up. Intentionally cheap: no DB access."""
    return {"status": "ok"}


@router.get("/health/db", response_model=None)
def health_check_db(db: Session = Depends(get_db)) -> JSONResponse | dict[str, str]:
    """Report API + PostgreSQL connectivity by executing a real `SELECT 1`.

    Never leaks driver or credential details in the response.
    """
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - any failure means "unreachable"
        return JSONResponse(
            status_code=503,
            content={"status": "error", "database": "unavailable"},
        )
    return {"status": "ok", "database": "connected"}
