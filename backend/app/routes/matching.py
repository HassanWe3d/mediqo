"""Matching route (Step 7) — intentionally thin.

All logic lives in `app.services.matching_service`; this module only
validates input (via Pydantic) and delegates.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.matching import MatchRequest, MatchResponse
from app.services.ai_service import AIService, get_ai_service
from app.services.matching_service import match_doctors

router = APIRouter(tags=["Matching"])


@router.post(
    "/match-doctors",
    response_model=MatchResponse,
    summary="Match doctors to a location + problem description",
    description=(
        "The core Mediqo flow: analyzes the problem (non-diagnostic AI), "
        "gates emergencies, then deterministically ranks doctors from "
        "PostgreSQL by weighted suitability — specialization, distance, "
        "availability, language, rating — with data-backed match reasons. "
        "Returns at most 5 doctors.\n\n"
        "`status`: `success` (or a clearly-marked General Physician "
        "fallback), `emergency` (no ranking; seek emergency care), "
        "`no_match` (nothing suitable found)."
    ),
    responses={422: {"description": "Invalid coordinates or problem text"}},
)
def match_doctors_endpoint(
    payload: MatchRequest,
    db: Session = Depends(get_db),
    ai_service: AIService = Depends(get_ai_service),
) -> MatchResponse:
    return match_doctors(
        latitude=payload.latitude,
        longitude=payload.longitude,
        problem=payload.problem,
        language=payload.language,
        db=db,
        ai_service=ai_service,
    )
