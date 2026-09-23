"""Contracts for medical-problem analysis (Step 5).

`MedicalProblemAnalysis` is produced by the AI service and will later be
consumed by the matching engine (Step 7). Mediqo is NOT a diagnostic system:
the analysis names the likely relevant *medical specialty*, never a disease.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# The exact specializations available in the Mediqo doctor database.
# The AI must map into these (never invent new ones).
SUPPORTED_SPECIALIZATIONS: list[str] = [
    "General Physician",
    "Cardiologist",
    "Dermatologist",
    "Dentist",
    "Orthopedic",
    "Gastroenterologist",
    "ENT Specialist",
    "Pediatrician",
    "Gynecologist",
    "Neurologist",
    "Ophthalmologist",
]

Specialization = Literal[
    "General Physician",
    "Cardiologist",
    "Dermatologist",
    "Dentist",
    "Orthopedic",
    "Gastroenterologist",
    "ENT Specialist",
    "Pediatrician",
    "Gynecologist",
    "Neurologist",
    "Ophthalmologist",
]

Urgency = Literal["normal", "urgent", "emergency"]

MAX_PROBLEM_LENGTH = 1000


class MedicalProblemAnalysis(BaseModel):
    """Structured understanding of a user's problem description."""

    specialization: Specialization = Field(
        default="General Physician",
        description="Likely relevant medical specialty (never a diagnosis)",
    )
    urgency: Urgency = Field(
        default="normal",
        description="normal | urgent | emergency — emergency routes to emergency care, not matching",
    )
    summary: str = Field(
        min_length=1,
        max_length=500,
        description="One concise, non-diagnostic sentence about what evaluation may help",
    )
    possible_keywords: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Short symptom phrases extracted from the description (not diagnoses)",
    )
    # Internal provenance marker ("provider" | "fallback" | "emergency").
    # Excluded from serialization, so it never appears in API responses —
    # but services/tests can distinguish a real analysis from a fallback.
    source: Literal["provider", "fallback", "emergency"] | None = Field(
        default=None, exclude=True
    )


class AnalysisRequest(BaseModel):
    """Request body for POST /analyze-problem."""

    problem: str = Field(
        min_length=3,
        max_length=MAX_PROBLEM_LENGTH,
        description="The user's description of their medical problem, in their own words",
    )

    @field_validator("problem")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Problem description must not be empty or whitespace-only")
        return value.strip()


# ---------------------------------------------------------------------------
# Matching engine contracts (Step 7)
# ---------------------------------------------------------------------------

class MatchRequest(BaseModel):
    """Request body for POST /match-doctors."""

    latitude: float = Field(ge=-90, le=90, description="User latitude in decimal degrees")
    longitude: float = Field(ge=-180, le=180, description="User longitude in decimal degrees")
    problem: str = Field(
        min_length=3,
        max_length=MAX_PROBLEM_LENGTH,
        description="The user's description of their medical problem",
    )
    language: str | None = Field(
        default=None,
        min_length=2,
        max_length=50,
        description="Optional preferred language, e.g. 'English' or 'Hindi'",
    )

    @field_validator("problem")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Problem description must not be empty or whitespace-only")
        return value.strip()

    @field_validator("language")
    @classmethod
    def clean_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class DoctorSummary(BaseModel):
    """The doctor fields shown on a match card (lean; full profile via
    GET /doctors/{id})."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    specialization: str
    qualification: str
    experience_years: int
    languages: list[str]
    consultation_fee: float
    clinic_name: str
    city: str
    rating: float
    review_count: int
    availability: dict
    profile_image: str | None
    is_demo: bool


class MatchResult(BaseModel):
    """One recommended doctor with an explainable score."""

    doctor: DoctorSummary
    distance_km: float = Field(ge=0, description="Straight-line distance in km (Haversine)")
    match_score: int = Field(ge=0, le=100, description="Weighted suitability score, 0-100")
    match_reasons: list[str] = Field(
        description="Deterministic, data-backed reasons — each one corresponds to reality"
    )


class MatchResponse(BaseModel):
    """Response for POST /match-doctors.

    status:
      - success:   results ranked by match_score (possibly a clearly-marked
                   General Physician fallback — see `message`)
      - emergency: urgency gate triggered; no ranking is performed
      - no_match:  nothing suitable found (no silent substitutions)
    """

    status: Literal["success", "emergency", "no_match"]
    analysis: MedicalProblemAnalysis | None = None
    results: list[MatchResult] = Field(default_factory=list, max_length=5)
    total_results: int = Field(default=0, ge=0, le=5)
    message: str | None = None
