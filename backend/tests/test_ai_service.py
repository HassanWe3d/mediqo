"""Mediqo — Step 5 AI service verification script.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_ai_service.py

All tests use the deterministic offline providers (KeywordProvider and stub
providers) — NO live AI calls, NO API keys required.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import Doctor
from app.schemas.matching import MedicalProblemAnalysis, SUPPORTED_SPECIALIZATIONS
from app.services.ai_service import (
    AIProviderError,
    MediqoAIService,
    KeywordProvider,
    OpenAIProvider,
    detect_emergency,
    emergency_analysis,
    get_ai_service,
)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def classify(problem: str) -> MedicalProblemAnalysis:
    return MediqoAIService(KeywordProvider()).analyze_medical_problem(problem)


class StubProvider:
    """Configurable stub: returns a canned analysis or raises."""

    name = "stub"

    def __init__(self, analysis: MedicalProblemAnalysis | None = None, error: Exception | None = None):
        self._analysis = analysis
        self._error = error

    def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
        if self._error is not None:
            raise self._error
        assert self._analysis is not None
        return self._analysis


def main() -> int:
    print("Mediqo Step 5 — AI service verification")
    print("=" * 60)

    # --- Specialty mapping (deterministic keyword provider) ---
    cases = [
        ("I have severe tooth pain.", "Dentist"),
        ("My skin has developed a rash.", "Dermatologist"),
        ("I have blurry vision.", "Ophthalmologist"),
        ("My child has fever.", "Pediatrician"),
        ("I have stomach pain and digestive problems.", "Gastroenterologist"),
        ("My knees hurt when I climb stairs.", "Orthopedic"),
        ("I have a sore throat and blocked nose.", "ENT Specialist"),
        ("I get frequent migraines.", "Neurologist"),
        ("I have palpitations and my heart races at night.", "Cardiologist"),
    ]
    for problem, expected in cases:
        analysis = classify(problem)
        expect(
            analysis.specialization == expected,
            f"'{problem}' -> {expected}",
            f"got {analysis.specialization} (summary: {analysis.summary[:70]})",
        )

    # Unclear input falls back to General Physician
    analysis = classify("I feel strange lately.")
    expect(analysis.specialization == "General Physician",
           "Unclear description falls back to General Physician",
           f"got {analysis.specialization}")

    # Negation handling: 'no rash' should not imply Dermatologist
    analysis = classify("I have fever but no rash on my skin.")
    expect(analysis.specialization != "Dermatologist",
           "Negated symptom ('no rash') does not force Dermatologist",
           f"got {analysis.specialization}")

    # --- Urgency: normal vs emergency (safety net) ---
    expect(not detect_emergency("I have mild stomach discomfort."),
           "Mild discomfort is not an emergency")
    urgent = classify("The pain is unbearable and it keeps getting worse.")
    expect(urgent.urgency == "urgent",
           "Rapidly worsening description classifies as urgent (not emergency)",
           f"got {urgent.urgency}")
    expect(classify("I have severe tooth pain.").urgency == "normal",
           "Bare 'severe' stays normal per spec example")
    emergency_inputs = [
        "I have crushing chest pain and my left arm feels numb.",
        "My father is unconscious and not breathing.",
        "There is severe bleeding after the accident.",
    ]
    for problem in emergency_inputs:
        analysis = classify(problem)
        expect(
            analysis.urgency == "emergency"
            and analysis.specialization == "General Physician"
            and "emergency" in analysis.summary.lower(),
            f"Emergency safety net: '{problem[:45]}...' -> emergency, no diagnosis",
            f"got urgency={analysis.urgency}, spec={analysis.specialization}",
        )
    expect(emergency_analysis().possible_keywords == [],
           "Emergency response contains no diagnostic keywords")

    # --- Output is always the validated contract ---
    for problem in ("I have severe tooth pain.", "hello world", "My child has fever."):
        analysis = classify(problem)
        MedicalProblemAnalysis.model_validate(analysis)
    expect(True, "All analyses validate against the MedicalProblemAnalysis schema")

    # --- Specializations match the doctor database exactly ---
    session = SessionLocal()
    try:
        db_specializations = set(
            session.execute(select(Doctor.specialization).distinct()).scalars()
        )
    finally:
        session.close()
    expect(db_specializations == set(SUPPORTED_SPECIALIZATIONS),
           "Supported specialties exactly match the doctor database",
           f"db: {sorted(db_specializations)}")

    # --- Fallback behaviour (provider unavailable) ---
    failing = MediqoAIService(StubProvider(error=AIProviderError("provider down")))
    result = failing.analyze_medical_problem("I have severe tooth pain.")
    expect(
        result.specialization == "General Physician"
        and result.urgency == "normal"
        and result.source == "fallback",
        "Provider failure -> safe fallback (honest source marker)",
        f"got {result.specialization}/{result.urgency}/source={result.source}",
    )
    expect(result.summary.startswith("We could not fully analyze"),
           "Fallback summary is honest about incomplete analysis")

    # Emergency still wins even when the provider is down
    result = failing.analyze_medical_problem("I can't breathe properly.")
    expect(result.urgency == "emergency" and result.source == "emergency",
           "Emergency safety net works even when provider is down")

    # Provider success path carries honest source marker
    canned = MedicalProblemAnalysis(
        specialization="Dentist", urgency="normal",
        summary="A dental evaluation may be appropriate.",
        possible_keywords=["tooth pain"],
    )
    ok = MediqoAIService(StubProvider(analysis=canned))
    result = ok.analyze_medical_problem("I have severe tooth pain.")
    expect(result.source == "provider" and result.specialization == "Dentist",
           "Provider success path marks source honestly")

    # Blank input is rejected by the service (defense in depth)
    rejected = False
    try:
        classify("   ")
    except ValueError:
        rejected = True
    expect(rejected, "Blank input rejected before reaching any provider")

    # --- OpenAI provider JSON parsing (offline, no network) ---
    parsed = OpenAIProvider._parse_content(
        '```json\n{"specialization": "dentist", "urgency": "normal",'
        ' "summary": "ok", "possible_keywords": ["tooth pain"]}\n```'
    )
    expect(parsed is not None and parsed.specialization == "Dentist",
           "AI JSON with code fences parses and normalizes casing")
    expect(OpenAIProvider._parse_content("this is not json") is None,
           "Malformed AI output is detected (not parsed)")
    expect(OpenAIProvider._parse_content(
        '{"specialization": "Wizard", "urgency": "normal", "summary": "x"}'
    ) is None,
           "Invented specialties are rejected (must match the doctor database)")
    expect(OpenAIProvider._parse_content(
        '{"specialization": "Cardiologist", "urgency": "weird", "summary": "x"}'
    ) is not None
    and OpenAIProvider._parse_content(
        '{"specialization": "Cardiologist", "urgency": "weird", "summary": "x"}'
    ).urgency == "normal",
           "Invalid urgency degrades safely to normal")

    # Configured provider builds without crashing (keyword mode, no key needed)
    service = get_ai_service()
    expect(service.analyze_medical_problem("I have tooth pain.").specialization == "Dentist",
           "get_ai_service() builds the configured provider and works")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All AI service checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
