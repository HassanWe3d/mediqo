"""AI analysis route: POST /analyze-problem (Step 5).

Converts a plain-language medical problem into structured, non-diagnostic
data (likely specialty + urgency). The internal `source` marker on the
service result is intentionally stripped by the response model.
"""

from fastapi import APIRouter, Depends, status

from app.schemas.matching import AnalysisRequest, MedicalProblemAnalysis
from app.services.ai_service import AIService, get_ai_service

router = APIRouter(tags=["AI Analysis"])


@router.post(
    "/analyze-problem",
    response_model=MedicalProblemAnalysis,
    status_code=status.HTTP_200_OK,
    summary="Understand a medical problem description (non-diagnostic)",
    description=(
        "Analyzes a plain-language problem and returns the likely relevant "
        "medical specialty plus an urgency class. **Not a diagnosis.** "
        "Emergency-looking descriptions return `urgency: \"emergency\"` and "
        "direct the user to emergency medical care instead of doctor matching."
    ),
    responses={
        422: {"description": "Invalid input (empty, whitespace-only, or too long)"},
    },
)
def analyze_problem(
    payload: AnalysisRequest,
    service: AIService = Depends(get_ai_service),
) -> MedicalProblemAnalysis:
    result = service.analyze_medical_problem(payload.problem)
    return result  # `source` is internal; response_model filters it out
