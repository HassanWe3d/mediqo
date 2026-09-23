"""Mediqo core matching engine (Step 7).

Deterministic, explainable doctor matching:

    route (thin)
      └─> match_doctors()
            ├─> ai_service.analyze_medical_problem()   (specialty + urgency)
            ├─> urgency gate                            (emergency -> no ranking)
            └─> match_from_analysis()
                  ├─> PostgreSQL: specialization filter (controlled GP fallback)
                  ├─> location_service.calculate_distance()  (Haversine)
                  ├─> component scores (documented curves below)
                  ├─> weighted score from config.MATCH_WEIGHTS
                  ├─> deterministic, data-backed match reasons
                  └─> top MAX_RESULTS doctors, sorted by score

DESIGN PRINCIPLE: the AI only answers "which specialty is relevant?".
The matching engine answers "which doctors fit best?" — deterministically,
from real data, with reasons that always correspond to reality.

The AI is never asked which doctor to recommend, and it never produces
scores or reasons.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, time as dt_time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import MATCH_WEIGHTS
from app.models import Doctor
from app.schemas.matching import (
    DoctorSummary,
    MatchResponse,
    MatchResult,
    MedicalProblemAnalysis,
)
from app.services.location_service import calculate_distance
from app.services.ai_service import AIService

logger = logging.getLogger("mediqo.matching")

# Weights must form a proper probability distribution.
if abs(sum(MATCH_WEIGHTS.values()) - 1.0) > 1e-9:
    raise RuntimeError(
        f"MATCH_WEIGHTS must sum to 1.0 (got {sum(MATCH_WEIGHTS.values())})"
    )

# ---------------------------------------------------------------------------
# Tunable engine constants (documented; change here, not in the algorithms)
# ---------------------------------------------------------------------------
MAX_RESULTS = 5  # "the most suitable ones" — never dump the whole database

# Distance score decay:  score = 100 · e^(−distance_km / DISTANCE_DECAY_KM)
#   0 km -> 100 | 1 km -> 81.9 | 5 km -> 36.8 | 10 km -> 13.5 | 20 km -> 1.8
# Smooth exponential decay — no abrupt cliff at an arbitrary radius.
DISTANCE_DECAY_KM = 5.0

# If the AI-identified specialty has no doctors, fall back to General
# Physicians — clearly marked, never silent. Their specialization score
# is lower than an exact match, and reasons say so.
GP_FALLBACK_SPECIALIZATION_SCORE = 60.0

# "Highly rated" reason threshold (rating is only 10% of the score — it can
# nudge, never dominate).
RATING_HIGH_THRESHOLD = 4.5

_LANGUAGE_NEUTRAL_SCORE = 50.0  # no preference given -> no doctor punished
_AVAILABILITY_NEUTRAL_SCORE = 50.0  # no schedule information -> neutral

EMERGENCY_MESSAGE = (
    "The description may require immediate medical attention. Please contact "
    "local emergency medical services or visit the nearest emergency facility."
)
NO_MATCH_MESSAGE = "We couldn't find a matching specialist nearby."
FALLBACK_MESSAGE = "Specialist unavailable nearby — showing General Physicians."

_DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_NAMES = {
    "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
    "fri": "Friday", "sat": "Saturday", "sun": "Sunday",
}


# ---------------------------------------------------------------------------
# Scoring components (pure functions — unit-testable in isolation)
# ---------------------------------------------------------------------------

def distance_score(distance_km: float) -> float:
    """Normalized distance score, 0-100.

    Formula: 100 · e^(−distance_km / DISTANCE_DECAY_KM). See the constant
    above for the documented curve values.
    """
    return 100.0 * math.exp(-max(distance_km, 0.0) / DISTANCE_DECAY_KM)


def rating_score(rating: float) -> float:
    """Normalized rating score: 5.0 -> 100, 4.5 -> 90, 4.0 -> 80, 0 -> 0."""
    return max(0.0, min(100.0, (float(rating) / 5.0) * 100.0))


def language_score(doctor_languages: list[str], preferred: str | None) -> float:
    """100 if the doctor speaks the preferred language, 0 if not.

    No preference given -> neutral 50 (doctors are not punished for a
    requirement the user never made).
    """
    if not preferred:
        return _LANGUAGE_NEUTRAL_SCORE
    return (
        100.0
        if any(lang.lower() == preferred.lower() for lang in doctor_languages)
        else 0.0
    )


def _day_key(moment: datetime) -> str:
    return _DAY_KEYS[moment.weekday()]


def _parse_intervals(availability: dict, key: str) -> list[tuple[dt_time, dt_time]]:
    """Parse the JSONB schedule shape {day: [["HH:MM", "HH:MM"], ...]}."""
    intervals: list[tuple[dt_time, dt_time]] = []
    for raw in availability.get(key) or []:
        if not (isinstance(raw, (list, tuple)) and len(raw) == 2):
            continue
        try:
            start = dt_time(*[int(part) for part in str(raw[0]).split(":")[:2]])
            end = dt_time(*[int(part) for part in str(raw[1]).split(":")[:2]])
        except (TypeError, ValueError):
            continue  # malformed interval -> ignore, never crash
        intervals.append((start, end))
    return intervals


def availability_score(availability: dict, now: datetime) -> tuple[float, str | None]:
    """Score availability against `now` (injected for deterministic tests).

    100 open right now | 90 opens later today | 70 tomorrow
    | 55 within 3 days | 30 scheduled but not soon | 50 neutral when the
    schedule is empty (missing data must not crash scoring).
    """
    if not availability:
        return _AVAILABILITY_NEUTRAL_SCORE, None

    today = _parse_intervals(availability, _day_key(now))
    current = now.time()
    if today:
        for start, end in today:
            if start <= current <= end:
                return 100.0, "Available today"
        if any(start > current for start, _ in today):
            return 90.0, "Available later today"

    for offset in (1, 2, 3):
        key = _day_key(now + timedelta(days=offset))
        if _parse_intervals(availability, key):
            label = "tomorrow" if offset == 1 else _DAY_NAMES[key]
            return (70.0, "Available tomorrow") if offset == 1 else (
                55.0,
                f"Available {label}",
            )

    return 30.0, "Not available today"


def combine_scores(component_scores: dict[str, float]) -> int:
    """Weighted total (config.MATCH_WEIGHTS), rounded to a whole number."""
    total = sum(MATCH_WEIGHTS[name] * value for name, value in component_scores.items())
    return int(round(max(0.0, min(100.0, total))))


def build_match_reasons(
    doctor: Doctor,
    distance_km: float,
    availability_reason: str | None,
    preferred_language: str | None,
    fallback: bool,
) -> list[str]:
    """Deterministic reasons, each backed by actual data.

    Never claims availability/language/rating that the doctor does not have.
    """
    reasons: list[str] = []
    if fallback:
        reasons.append("General Physician — nearest available alternative")
    else:
        reasons.append("Relevant specialization")

    if distance_km < 1.0:
        reasons.append("Less than 1 km away")
    else:
        reasons.append(f"{distance_km:.1f} km away")

    if availability_reason:
        reasons.append(availability_reason)

    if preferred_language and any(
        lang.lower() == preferred_language.lower() for lang in doctor.languages
    ):
        reasons.append(f"Speaks {preferred_language}")

    if float(doctor.rating) >= RATING_HIGH_THRESHOLD:
        reasons.append("Highly rated")

    return reasons


# ---------------------------------------------------------------------------
# Candidate resolution (DB-level specialty filter; module-level so tests can
# simulate a missing specialty without touching real data)
# ---------------------------------------------------------------------------

def _query_by_specialization(db: Session, specialization: str) -> list[Doctor]:
    return list(
        db.scalars(
            select(Doctor).where(
                func.lower(Doctor.specialization) == specialization.strip().lower()
            )
        ).all()
    )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def match_doctors(
    latitude: float,
    longitude: float,
    problem: str,
    language: str | None,
    db: Session,
    ai_service: AIService,
) -> MatchResponse:
    """Full pipeline: AI analysis -> urgency gate -> deterministic matching."""
    analysis = ai_service.analyze_medical_problem(problem)
    return match_from_analysis(
        latitude=latitude,
        longitude=longitude,
        analysis=analysis,
        language=language,
        db=db,
    )


def match_from_analysis(
    latitude: float,
    longitude: float,
    analysis: MedicalProblemAnalysis,
    language: str | None,
    db: Session,
) -> MatchResponse:
    """Deterministic matching for an already-computed analysis."""
    # --- Urgency gate: emergency never enters normal ranking ---
    if analysis.urgency == "emergency":
        logger.info("match: emergency gate triggered — no ranking performed")
        return MatchResponse(
            status="emergency",
            analysis=analysis,
            results=[],
            total_results=0,
            message=EMERGENCY_MESSAGE,
        )

    preferred_language = (language or "").strip() or None
    requested = analysis.specialization

    doctors = _query_by_specialization(db, requested)
    fallback = False
    if not doctors:
        # Controlled fallback: General Physicians only, clearly marked.
        doctors = _query_by_specialization(db, "General Physician")
        fallback = bool(doctors)

    if not doctors:
        logger.info("match: no candidates for '%s'", requested)
        return MatchResponse(
            status="no_match",
            analysis=analysis,
            results=[],
            total_results=0,
            message=NO_MATCH_MESSAGE,
        )

    now = datetime.now()
    scored: list[tuple[int, float, float, MatchResult]] = []
    for doctor in doctors:
        distance_km = calculate_distance(latitude, longitude, doctor.latitude, doctor.longitude)
        availability, availability_reason = availability_score(doctor.availability, now)
        component_scores = {
            "specialization": (
                100.0
                if not fallback or doctor.specialization == requested
                else GP_FALLBACK_SPECIALIZATION_SCORE
            ),
            "distance": distance_score(distance_km),
            "availability": availability,
            "language": language_score(doctor.languages, preferred_language),
            "rating": rating_score(doctor.rating),
        }
        match_score = combine_scores(component_scores)
        reasons = build_match_reasons(
            doctor, distance_km, availability_reason, preferred_language, fallback
        )
        scored.append(
            (
                match_score,
                distance_km,
                float(doctor.rating),
                MatchResult(
                    doctor=DoctorSummary.model_validate(doctor),
                    distance_km=round(distance_km, 1),
                    match_score=match_score,
                    match_reasons=reasons,
                ),
            )
        )

    # Deterministic order: score desc, then distance asc, then rating desc.
    scored.sort(key=lambda item: (-item[0], item[1], -item[2]))
    top = scored[:MAX_RESULTS]

    logger.info(
        "match: specialty=%s urgency=%s candidates=%d returned=%d fallback=%s language=%s",
        requested,
        analysis.urgency,
        len(doctors),
        len(top),
        fallback,
        preferred_language or "none",
    )

    return MatchResponse(
        status="success",
        analysis=analysis,
        results=[item[3] for item in top],
        total_results=len(top),
        message=FALLBACK_MESSAGE if fallback else None,
    )
