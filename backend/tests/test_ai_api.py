"""Mediqo — Step 5 API verification script for POST /analyze-problem.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_ai_api.py

Uses FastAPI's TestClient. The default provider (keyword rules) is offline
and deterministic; provider substitution and failure are simulated via
dependency overrides — NO live AI calls.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from app.main import app
from app.schemas.matching import MedicalProblemAnalysis
from app.services.ai_service import AIProviderError, MediqoAIService, get_ai_service
from tests.test_ai_service import StubProvider

client = TestClient(app)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def main() -> int:
    print("Mediqo Step 5 — /analyze-problem API verification")
    print("=" * 60)

    # 1. Valid input -> 200, schema-conformant, non-diagnostic fields only
    response = client.post("/analyze-problem", json={"problem": "I have severe tooth pain since yesterday."})
    expect(response.status_code == 200, "Valid input returns 200",
           f"got {response.status_code}: {response.text[:120]}")
    body = response.json()
    expect(set(body) == {"specialization", "urgency", "summary", "possible_keywords"},
           "Response matches the public schema exactly (no internals leaked)",
           f"keys: {sorted(body)}")
    MedicalProblemAnalysis.model_validate(body)
    expect(True, "Response validates against MedicalProblemAnalysis")
    expect(body["specialization"] == "Dentist" and body["urgency"] == "normal",
           "Tooth pain -> Dentist / normal",
           f"got {body['specialization']}/{body['urgency']}")

    # 2. More mappings through the API
    for problem, expected in [
        ("My skin has a rash.", "Dermatologist"),
        ("I have blurry vision.", "Ophthalmologist"),
        ("My child has fever.", "Pediatrician"),
    ]:
        data = client.post("/analyze-problem", json={"problem": problem}).json()
        expect(data["specialization"] == expected,
               f"'{problem}' -> {expected}", f"got {data['specialization']}")

    data = client.post("/analyze-problem", json={"problem": "I have stomach pain."}).json()
    expect(data["specialization"] in {"Gastroenterologist", "General Physician"},
           "Stomach pain -> Gastroenterologist or General Physician",
           f"got {data['specialization']}")
    expect(data["possible_keywords"] and all(isinstance(k, str) for k in data["possible_keywords"]),
           "possible_keywords is a list of strings")

    # 3. Emergency input -> emergency, no diagnosis
    data = client.post(
        "/analyze-problem",
        json={"problem": "I have crushing chest pain and I can't breathe."},
    ).json()
    expect(data["urgency"] == "emergency" and data["specialization"] == "General Physician",
           "Emergency input -> urgency=emergency, no diagnosis",
           f"got {data['urgency']}/{data['specialization']}")
    expect("emergency" in data["summary"].lower(),
           "Emergency summary directs to emergency medical care")

    # 4. Invalid inputs -> 422, clean responses
    for label, payload in [
        ("empty string", {"problem": ""}),
        ("whitespace only", {"problem": "   "}),
        ("too short", {"problem": "ok"}),
        ("too long", {"problem": "x" * 1001}),
        ("missing field", {}),
        ("wrong type", {"problem": 12345}),
    ]:
        response = client.post("/analyze-problem", json=payload)
        expect(response.status_code == 422, f"Invalid input rejected (422): {label}",
               f"got {response.status_code}")

    # 5. Mocked provider works through the API
    canned = MedicalProblemAnalysis(
        specialization="Cardiologist",
        urgency="urgent",
        summary="A cardiology evaluation may be appropriate.",
        possible_keywords=["palpitations"],
    )
    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(StubProvider(analysis=canned))
    try:
        data = client.post("/analyze-problem", json={"problem": "my heart races"}).json()
        expect(data["specialization"] == "Cardiologist" and data["urgency"] == "urgent",
               "Mocked AI provider is used via dependency override",
               f"got {data['specialization']}/{data['urgency']}")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # 6. AI failure -> controlled keyword fallback (never a crash, never a
    #    canned specialty — the deterministic rules keep matching relevant)
    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(
        StubProvider(error=AIProviderError("simulated outage"))
    )
    try:
        response = client.post("/analyze-problem", json={"problem": "I have stomach pain."})
        expect(response.status_code == 200, "AI failure returns 200 (graceful degradation)",
               f"got {response.status_code}")
        data = response.json()
        expect(data["specialization"] == "Gastroenterologist" and data["urgency"] == "normal",
               "AI failure -> problem-specific keyword fallback",
               f"got {data['specialization']}/{data['urgency']}")
        other = client.post("/analyze-problem",
                            json={"problem": "My skin has a rash."}).json()
        expect(other["specialization"] == "Dermatologist"
               and other["specialization"] != data["specialization"],
               "Fallback specialty differs per problem through the API")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # 7. Emergency bypasses even a failing provider
    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(
        StubProvider(error=AIProviderError("down"))
    )
    try:
        data = client.post(
            "/analyze-problem", json={"problem": "There is severe bleeding!"}
        ).json()
        expect(data["urgency"] == "emergency",
               "Emergency safety net outranks provider failure")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # 8. OpenAPI documents the endpoint
    openapi = client.get("/openapi.json").json()
    expect("/analyze-problem" in openapi["paths"],
           "OpenAPI documents POST /analyze-problem")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All AI API checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
