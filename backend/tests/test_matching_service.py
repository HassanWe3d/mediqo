"""Mediqo — Step 7 matching engine verification script.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_matching_service.py

Scoring components are tested as pure functions with an injected `now`
(deterministic — no clock dependence). Pipeline tests use the real seeded
PostgreSQL database and the offline keyword AI provider. Expected scores are
recomputed from first principles — no hardcoded winners.
"""

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import MATCH_WEIGHTS
from app.services import matching_service
from app.database import SessionLocal
from app.main import app
from app.models import Doctor
from app.schemas.matching import MedicalProblemAnalysis
from app.services.ai_service import AIProviderError, MediqoAIService, get_ai_service
from app.services.matching_service import (
    availability_score,
    combine_scores,
    distance_score,
    language_score,
    match_from_analysis,
    rating_score,
)
from tests.test_ai_service import StubProvider

client = TestClient(app)

# Fixed "now" for component tests: 2026-09-23 is a Wednesday, 12:00 noon.
NOW = datetime(2026, 9, 23, 12, 0)

LUCKNOW = (26.8467, 80.9462)
KANPUR = (26.4499, 80.3329)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def match(problem: str, latitude: float = LUCKNOW[0], longitude: float = LUCKNOW[1],
          language: str | None = None) -> dict:
    payload = {"latitude": latitude, "longitude": longitude, "problem": problem}
    if language:
        payload["language"] = language
    response = client.post("/match-doctors", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def main() -> int:
    print("Mediqo Step 7 — matching engine verification")
    print("=" * 60)

    # ---- Weights configuration ----
    expect(abs(sum(MATCH_WEIGHTS.values()) - 1.0) < 1e-9,
           "MATCH_WEIGHTS sum to 1.0", f"got {MATCH_WEIGHTS}")

    # ---- Component: distance score (documented curve) ----
    expect(distance_score(0) == 100.0, "distance_score(0) == 100")
    expect(75 <= distance_score(1) <= 90, "1 km scores very high", f"got {distance_score(1):.1f}")
    expect(30 <= distance_score(5) <= 45, "5 km scores moderate", f"got {distance_score(5):.1f}")
    expect(8 <= distance_score(10) <= 20, "10+ km scores low", f"got {distance_score(10):.1f}")
    expect(distance_score(5) > distance_score(6) > distance_score(10),
           "distance score decays monotonically (no cliffs)")

    # ---- Component: rating score (exact mapping) ----
    expect(rating_score(5.0) == 100 and rating_score(4.5) == 90 and rating_score(4.0) == 80,
           "rating_score maps 5.0/4.5/4.0 -> 100/90/80")

    # ---- Component: language score ----
    expect(language_score(["English", "Hindi"], "English") == 100, "Speaks preferred -> 100")
    expect(language_score(["Hindi"], "English") == 0, "Does not speak -> 0")
    expect(language_score(["Hindi"], None) == 50, "No preference -> neutral 50")

    # ---- Component: availability score (deterministic `now`) ----
    expect(availability_score({"wed": [["09:00", "13:00"]]}, NOW) == (100.0, "Available today"),
           "Open right now -> 100 'Available today'")
    expect(availability_score({"wed": [["16:00", "20:00"]]}, NOW)[0] == 90.0,
           "Opens later today -> 90")
    expect(availability_score({"thu": [["09:00", "13:00"]]}, NOW) == (70.0, "Available tomorrow"),
           "Open tomorrow -> 70 'Available tomorrow'")
    expect(availability_score({"fri": [["09:00", "13:00"]]}, NOW) == (55.0, "Available Friday"),
           "Open within 3 days -> 55 with weekday name")
    expect(availability_score({"mon": [["09:00", "13:00"]]}, NOW)[0] == 30.0,
           "Nothing within 3 days -> 30")
    expect(availability_score({}, NOW) == (50.0, None),
           "Empty schedule -> neutral 50, no reason, no crash")
    expect(availability_score({"wed": [["oops"]]}, NOW)[0] == 30.0,
           "Malformed intervals never crash the scorer")

    # ---- Component: weighted combination ----
    combined = combine_scores({"specialization": 100, "distance": 100, "availability": 100,
                               "language": 50, "rating": 80})
    expect(combined == 93, "Weighted combination uses config weights exactly",
           f"got {combined}")

    # ---- Pipeline: specialty routing (scenarios 1-4) ----
    # Lucknow supplies every specialty; specialists lead, and when the local
    # specialty has fewer than 5 doctors, honestly-labelled General
    # Physicians top the list up (ranked after every specialist).
    for problem, expected_spec in [
        ("I have severe tooth pain", "Dentist"),
        ("I have a skin rash", "Dermatologist"),
        ("My child has a fever", "Pediatrician"),
        ("I have blurry vision", "Ophthalmologist"),
    ]:
        body = match(problem)
        expect(body["status"] == "success"
               and body["analysis"]["specialization"] == expected_spec
               and body["total_results"] > 0
               and body["results"][0]["doctor"]["specialization"] == expected_spec,
               f"'{problem}' -> {expected_spec} leads the results",
               f"got {body['analysis']['specialization']} / {body['total_results']} results")
        gp_tails = [r for r in body["results"]
                    if r["doctor"]["specialization"] != expected_spec]
        expect(all("General Physician — nearest available alternative"
                   in r["match_reasons"] for r in gp_tails),
               f"'{problem}': any non-specialist members are honestly labelled")

    # ---- Scenario 12: maximum 5 results ----
    body = match("I feel unwell and weak")  # General Physician: 6 in DB
    expect(len(body["results"]) == 5 and body["total_results"] == 5,
           "At most 5 results returned (6 GPs exist)", f"got {len(body['results'])}")

    # ---- Scenario 10: scores within 0-100, sorted ----
    expect(all(0 <= r["match_score"] <= 100 for r in body["results"]),
           "All match scores within 0-100")
    scores = [r["match_score"] for r in body["results"]]
    expect(scores == sorted(scores, reverse=True), "Results sorted by match_score desc")

    # ---- Scenario 5/6: location affects ranking & distances are real ----
    body_lko = match("I have severe tooth pain")
    body_knp = match("I have severe tooth pain", latitude=KANPUR[0], longitude=KANPUR[1])
    ids_lko = {r["doctor"]["id"] for r in body_lko["results"]}
    shared = next((r for r in body_knp["results"] if r["doctor"]["id"] in ids_lko), None)
    expect(shared is not None, "Same doctors visible from a different location")
    if shared:
        session = SessionLocal()
        try:
            doctor = session.scalar(select(Doctor).where(Doctor.id == shared["doctor"]["id"]))
        finally:
            session.close()
        from app.services.location_service import calculate_distance
        expected_km = calculate_distance(KANPUR[0], KANPUR[1], doctor.latitude, doctor.longitude)
        expect(abs(shared["distance_km"] - round(expected_km, 1)) < 0.05,
               "distance_km equals the recomputed Haversine distance",
               f"api={shared['distance_km']}, haversine={expected_km:.1f}")
    expect(body_lko["results"][0]["distance_km"] != body_knp["results"][0]["distance_km"],
           "Location changes the distance picture (ranking input)")

    # ---- Scenario 11: reasons correspond to reality ----
    now = datetime.now()
    session = SessionLocal()
    try:
        ok_reasons = True
        detail = ""
        for result in body_lko["results"]:
            doctor = session.scalar(select(Doctor).where(Doctor.id == result["doctor"]["id"]))
            reasons = result["match_reasons"]
            if "Relevant specialization" not in reasons:
                ok_reasons, detail = False, "missing specialization reason"
                break
            distance_km = matching_service.calculate_distance(
                LUCKNOW[0], LUCKNOW[1], doctor.latitude, doctor.longitude)
            expected_distance_reason = (
                "Less than 1 km away" if distance_km < 1 else f"{distance_km:.1f} km away"
            )
            if expected_distance_reason not in reasons:
                ok_reasons, detail = False, f"distance reason mismatch ({expected_distance_reason})"
                break
            _, availability_reason = matching_service.availability_score(doctor.availability, now)
            if availability_reason and availability_reason not in reasons:
                ok_reasons, detail = False, f"availability reason '{availability_reason}' missing"
                break
            if "Highly rated" in reasons and float(doctor.rating) < 4.5:
                ok_reasons, detail = False, "'Highly rated' on a low rating"
                break
            if "Highly rated" not in reasons and float(doctor.rating) >= 4.5:
                ok_reasons, detail = False, "high rating missing 'Highly rated'"
                break
        expect(ok_reasons, "Every match reason corresponds to actual doctor data", detail)

        # Full score recomputation from first principles (determinism check)
        ok_scores = True
        detail = ""
        for result in body_lko["results"]:
            doctor = session.scalar(select(Doctor).where(Doctor.id == result["doctor"]["id"]))
            distance_km = matching_service.calculate_distance(
                LUCKNOW[0], LUCKNOW[1], doctor.latitude, doctor.longitude)
            availability, _ = matching_service.availability_score(doctor.availability, now)
            expected = combine_scores({
                "specialization": 100.0,
                "distance": distance_score(distance_km),
                "availability": availability,
                "language": language_score(doctor.languages, None),
                "rating": rating_score(doctor.rating),
            })
            if abs(expected - result["match_score"]) > 1:  # ±1 tolerates clock edge
                ok_scores, detail = False, (
                    f"doctor {doctor.id}: recomputed {expected}, api {result['match_score']}")
                break
        expect(ok_scores, "match_score equals the documented weighted formula", detail)
    finally:
        session.close()

    # ---- Scenario 8: language affects ranking when provided ----
    body_plain = match("I have severe tooth pain")
    body_urdu = match("I have severe tooth pain", language="Urdu")
    urdu_speakers = {
        r["doctor"]["id"] for r in body_urdu["results"] if "Speaks Urdu" in r["match_reasons"]
    }
    session = SessionLocal()
    try:
        actual_urdu = set(session.scalars(
            select(Doctor.id).where(Doctor.languages.any("Urdu"))
        ).all())
    finally:
        session.close()
    expect(urdu_speakers <= actual_urdu and len(urdu_speakers) > 0,
           "'Speaks Urdu' reason only on doctors who truly speak Urdu",
           f"claimed={sorted(urdu_speakers)}, actual={sorted(actual_urdu)}")
    plain_by_id = {r["doctor"]["id"]: r["match_score"] for r in body_plain["results"]}
    urdu_by_id = {r["doctor"]["id"]: r["match_score"] for r in body_urdu["results"]}
    changed = {
        doc_id for doc_id in plain_by_id
        if doc_id in urdu_by_id and urdu_by_id[doc_id] != plain_by_id[doc_id]
    }
    expect(len(changed) > 0, "Language preference changes match scores",
           f"changed ids: {sorted(changed)}")
    expect(not any("Speaks" in reason for r in body_plain["results"]
                   for reason in r["match_reasons"]),
           "No language reason when no preference was given")

    # ---- Scenario 13: no-match behavior (simulated empty specialty) ----
    original_query = matching_service._query_by_specialization
    def empty_query(db, specialization):  # noqa: ANN001
        return []
    matching_service._query_by_specialization = empty_query
    try:
        analysis = MedicalProblemAnalysis(
            specialization="Cardiologist", urgency="normal",
            summary="A cardiology evaluation may be appropriate.",
        )
        response = match_from_analysis(LUCKNOW[0], LUCKNOW[1], analysis, None, SessionLocal())
        expect(response.status == "no_match" and response.results == []
               and response.message == "We couldn't find a matching specialist nearby.",
               "No-match returns explained empty response (no silent substitution)")
    finally:
        matching_service._query_by_specialization = original_query

    # ---- GP fallback behavior (clearly marked, honest reasons) ----
    def gp_only_for_cardio(db, specialization):  # noqa: ANN001
        if specialization == "Cardiologist":
            return []
        return original_query(db, specialization)
    matching_service._query_by_specialization = gp_only_for_cardio
    try:
        analysis = MedicalProblemAnalysis(
            specialization="Cardiologist", urgency="normal",
            summary="A cardiology evaluation may be appropriate.",
        )
        response = match_from_analysis(LUCKNOW[0], LUCKNOW[1], analysis, None, SessionLocal())
        expect(response.status == "success"
               and response.message == matching_service.FALLBACK_MESSAGE
               and all(r.doctor.specialization == "General Physician"
                       for r in response.results),
               "Missing specialty falls back to clearly-marked General Physicians")
        expect(all("General Physician — nearest available alternative" in r.match_reasons
                   for r in response.results),
               "Fallback results carry honest (non-'relevant') reasons")
        expect(all(r.match_score <= 90 for r in response.results),
               "Fallback specialization score stays below an exact match")
    finally:
        matching_service._query_by_specialization = original_query

    # ---- Scenario 14: emergency never enters ranking ----
    body = match("I have crushing chest pain and I cannot breathe.")
    expect(body["status"] == "emergency" and body["results"] == []
           and body["total_results"] == 0
           and "emergency" in body["message"].lower(),
           "Emergency input returns emergency guidance, no ranking",
           f"got {body['status']} / {len(body['results'])} results")
    expect(body["analysis"]["urgency"] == "emergency"
           and body["analysis"]["specialization"] == "General Physician",
           "Emergency analysis is non-diagnostic (GP + emergency)")

    # ---- Scenario 15/16: input validation ----
    expect(client.post("/match-doctors", json={
        "latitude": 95, "longitude": 0, "problem": "I have severe tooth pain"
    }).status_code == 422, "Invalid latitude rejected (422)")
    expect(client.post("/match-doctors", json={
        "latitude": LUCKNOW[0], "longitude": LUCKNOW[1], "problem": ""
    }).status_code == 422, "Empty problem rejected (422)")

    # ---- Scenario 17: AI failure handled safely ----
    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(
        StubProvider(error=AIProviderError("simulated outage"))
    )
    try:
        response = client.post("/match-doctors", json={
            "latitude": LUCKNOW[0], "longitude": LUCKNOW[1], "problem": "I have a skin rash"
        })
        expect(response.status_code == 200, "AI failure still returns 200")
        body = response.json()
        expect(body["status"] == "success"
               and body["analysis"]["specialization"] == "Dermatologist"
               and body["results"][0]["doctor"]["specialization"] == "Dermatologist",
               "AI failure -> problem-specific keyword fallback, safe matching")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # ---- OpenAPI ----
    openapi = client.get("/openapi.json").json()
    expect("/match-doctors" in openapi["paths"], "OpenAPI documents POST /match-doctors")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All matching engine checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
