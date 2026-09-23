"""Mediqo — Step 8 END-TO-END backend verification.

Run from the backend/ directory (seeded PostgreSQL must be reachable):

    .venv/Scripts/python.exe tests/test_e2e_flow.py

Exercises the COMPLETE product flow against the real database and the real
matching service: location + problem -> AI analysis -> urgency gate ->
PostgreSQL -> distance/availability/language/rating -> weighted score ->
explained top 5 -> doctor profile -> reviews.

The AI is the real configured provider (offline keyword rules —
deterministic, no network, no key). Only failure modes (AI outage, database
outage) are simulated, and the environment is always restored.
"""

import json
import subprocess
import sys
import time
from datetime import datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

from app.database import SessionLocal, engine
from app.main import app
from app.models import Doctor, Review
from app.schemas.matching import MedicalProblemAnalysis
from app.services.ai_service import AIProviderError, MediqoAIService, get_ai_service
from app.services import matching_service
from app.services.location_service import calculate_distance
from tests.test_ai_service import StubProvider

client = TestClient(app)

LUCKNOW = (26.8467, 80.9462)
KANPUR = (26.4499, 80.3329)
BARABANKI_RD = (26.9500, 81.1000)  # east of Lucknow — a different location

EXPECTED_OPENAPI_PATHS = {
    "/health",
    "/health/db",
    "/doctors",
    "/doctors/{doctor_id}",
    "/doctors/{doctor_id}/reviews",
    "/analyze-problem",
    "/location/validate",
    "/location/manual",
    "/match-doctors",
}

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
    return client.post("/match-doctors", json=payload)


def verify_match_shape(body: dict, expected_specialization: str) -> None:
    expect(body["status"] == "success", "  status == success", f"got {body.get('status')}")
    expect(body["analysis"]["specialization"] == expected_specialization,
           f"  analysis.specialization == {expected_specialization}",
           f"got {body['analysis']['specialization']}")
    expect(body["analysis"]["urgency"] in ("normal", "urgent"),
           "  urgency is not emergency")
    expect(0 < body["total_results"] <= 5 and len(body["results"]) <= 5,
           "  at most 5 doctors returned")
    # Specialists lead; when the local specialty has fewer than 5 doctors,
    # honestly-labelled General Physicians top up the list (never silently).
    expect(body["results"][0]["doctor"]["specialization"] == expected_specialization
           and all(r["doctor"]["specialization"] == expected_specialization
                   or "General Physician — nearest available alternative"
                   in r["match_reasons"]
                   for r in body["results"]),
           "  specialists lead; any GP top-up members are honestly labelled")
    expect(all(isinstance(r["distance_km"], (int, float)) and r["distance_km"] >= 0
               for r in body["results"]),
           "  distance_km present and non-negative")
    expect(all(0 <= r["match_score"] <= 100 for r in body["results"]),
           "  match_score between 0 and 100")
    expect(all(isinstance(r["match_reasons"], list) and r["match_reasons"]
               for r in body["results"]),
           "  match_reasons present")


def main() -> int:
    print("Mediqo Step 8 — END-TO-END backend verification")
    print("=" * 64)

    # =====================================================================
    # CASES 1-4: realistic user journeys through the complete pipeline
    # =====================================================================
    journeys = [
        ("I have severe tooth pain since yesterday", "Dentist"),
        ("I have a skin rash that has been bothering me.", "Dermatologist"),
        ("I have blurry vision and want to get my eyes checked.", "Ophthalmologist"),
        ("My child has a fever and I want to see a doctor.", "Pediatrician"),
    ]
    for index, (problem, expected) in enumerate(journeys, start=1):
        response = match(problem)
        expect(response.status_code == 200, f"CASE {index}: '{problem[:38]}…' -> HTTP 200",
               f"got {response.status_code}")
        verify_match_shape(response.json(), expected)

    # =====================================================================
    # CASE 5: location effect (two different user locations)
    # =====================================================================
    body_a = match("I have severe tooth pain", *LUCKNOW).json()
    body_b = match("I have severe tooth pain", *BARABANKI_RD).json()
    by_id_a = {r["doctor"]["id"]: r for r in body_a["results"]}
    by_id_b = {r["doctor"]["id"]: r for r in body_b["results"]}
    shared_ids = set(by_id_a) & set(by_id_b)
    expect(bool(shared_ids), "CASE 5: same specialty visible from both locations")
    distances_differ = any(
        by_id_a[doc_id]["distance_km"] != by_id_b[doc_id]["distance_km"]
        for doc_id in shared_ids
    )
    expect(distances_differ, "CASE 5: distance_km changes with user location")
    ranking_differs = (
        [r["doctor"]["id"] for r in body_a["results"]]
        != [r["doctor"]["id"] for r in body_b["results"]]
    )
    expect(ranking_differs or any(
        by_id_a[i]["match_score"] != by_id_b[i]["match_score"] for i in shared_ids),
        "CASE 5: ranking/scores respond to geography")
    session = SessionLocal()
    try:
        ok = True
        for doc_id in shared_ids:
            doctor = session.scalar(select(Doctor).where(Doctor.id == doc_id))
            expected_b = round(calculate_distance(*BARABANKI_RD, doctor.latitude, doctor.longitude), 1)
            if abs(by_id_b[doc_id]["distance_km"] - expected_b) > 0.05:
                ok = False
                break
        expect(ok, "CASE 5: location-B distances equal recomputed Haversine")
    finally:
        session.close()

    # =====================================================================
    # CASE 6: language ("English" on a mixed-language specialty)
    # =====================================================================
    body = match("My child has a fever and I want to see a doctor.", language="English").json()
    expect(body["status"] == "success", "CASE 6: pediatrician match with language=English")
    consistent = True
    any_claimed = False
    for result in body["results"]:
        speaks = "English" in result["doctor"]["languages"]
        claimed = "Speaks English" in result["match_reasons"]
        if claimed:
            any_claimed = True
        if speaks != claimed:
            consistent = False
    expect(consistent and any_claimed,
           "CASE 6: 'Speaks English' claimed only by real English speakers",
           f"any_claimed={any_claimed}")
    expect(all(r["doctor"]["is_demo"] for r in body["results"]),
           "CASE 6: results flagged is_demo=true")

    # =====================================================================
    # CASE 7: availability — controlled fixture inside a rolled-back tx
    # =====================================================================
    session = SessionLocal()
    try:
        doctor = session.scalar(
            select(Doctor).where(Doctor.specialization == "Dentist").order_by(Doctor.id)
        )
        analysis = MedicalProblemAnalysis(
            specialization="Dentist", urgency="normal",
            summary="A dental evaluation may be appropriate.",
        )
        base_response = matching_service.match_from_analysis(
            LUCKNOW[0], LUCKNOW[1], analysis, None, session
        )
        base = next(r for r in base_response.results if r.doctor.id == doctor.id)

        today_key = tuple("mon tue wed thu fri sat sun".split())[datetime.now().weekday()]
        doctor.availability = {today_key: [["00:00", "23:59"]]}
        open_response = matching_service.match_from_analysis(
            LUCKNOW[0], LUCKNOW[1], analysis, None, session
        )
        opened = next(r for r in open_response.results if r.doctor.id == doctor.id)
        expect(opened.match_score > base.match_score,
               "CASE 7: open-now availability raises the match score",
               f"{base.match_score} -> {opened.match_score}")
        expect("Available today" in opened.match_reasons,
               "CASE 7: 'Available today' appears for the open-now fixture",
               f"{opened.match_reasons}")
    finally:
        session.rollback()  # fixture never persisted
        session.close()

    session = SessionLocal()
    try:
        doctor = session.scalar(
            select(Doctor).where(Doctor.specialization == "Dentist").order_by(Doctor.id)
        )
        original_availability = doctor.availability
        doctor.availability = {"sun": []}
        analysis = MedicalProblemAnalysis(
            specialization="Dentist", urgency="normal",
            summary="A dental evaluation may be appropriate.",
        )
        closed_response = matching_service.match_from_analysis(
            LUCKNOW[0], LUCKNOW[1], analysis, None, session
        )
        closed = next(r for r in closed_response.results if r.doctor.id == doctor.id)
        closed_lower = any(
            "Available today" in r.match_reasons for r in closed_response.results
            if r.doctor.id == doctor.id
        )
        expect(not closed_lower and "Available today" not in closed.match_reasons,
               "CASE 7: closed schedule never claims 'Available today'")
        expect(original_availability is not None, "CASE 7: original schedule captured")
    finally:
        session.rollback()
        session.close()

    # Availability reason truthfulness on live data (no fixture)
    body = match("I have severe tooth pain").json()
    session = SessionLocal()
    try:
        truthful = True
        for result in body["results"]:
            doctor = session.scalar(select(Doctor).where(Doctor.id == result["doctor"]["id"]))
            _, reason = matching_service.availability_score(doctor.availability, datetime.now())
            if reason and reason not in result["match_reasons"]:
                truthful = False
            if not reason and any(r.startswith("Available") for r in result["match_reasons"]):
                truthful = False
        expect(truthful, "CASE 7: live availability reasons always match the schedule")
    finally:
        session.close()

    # =====================================================================
    # CASE 8: rating — controlled fixture, bounded influence
    # =====================================================================
    session = SessionLocal()
    try:
        # Lowest-rated Lucknow dentist (the dataset is now multi-city; this
        # case must rank the fixture doctor in the Lucknow candidate set):
        # raising 4.0 -> 5.0 must add ~2.0 points ((100 - 80) x 10%).
        doctor = session.scalar(
            select(Doctor)
            .where(Doctor.specialization == "Dentist", Doctor.city == "Lucknow")
            .order_by(Doctor.rating.asc())
            .limit(1)
        )
        original_rating = float(doctor.rating)
        analysis = MedicalProblemAnalysis(
            specialization="Dentist", urgency="normal",
            summary="A dental evaluation may be appropriate.",
        )
        before_response = matching_service.match_from_analysis(
            LUCKNOW[0], LUCKNOW[1], analysis, None, session
        )
        before = next(r for r in before_response.results if r.doctor.id == doctor.id)

        doctor.rating = Decimal("5.0")
        after_response = matching_service.match_from_analysis(
            LUCKNOW[0], LUCKNOW[1], analysis, None, session
        )
        after = next(r for r in after_response.results if r.doctor.id == doctor.id)

        delta = after.match_score - before.match_score
        max_possible = (100.0 - matching_service.rating_score(original_rating)) * 0.10
        expect(0 < delta <= max(2, round(max_possible) + 1),
               "CASE 8: higher rating raises the score, bounded by its 10% weight",
               f"{original_rating} -> 5.0 gave +{delta} (max {max_possible:.1f})")
        expect(after.match_score <= 100, "CASE 8: rating cannot push score above 100")
    finally:
        session.rollback()  # restore original rating
        session.close()

    # =====================================================================
    # CASE 9: no-match (simulated missing specialty) through the API
    # =====================================================================
    original_query = matching_service._query_by_specialization
    matching_service._query_by_specialization = lambda db, spec: []
    try:
        response = match("I have severe tooth pain")
        body = response.json()
        expect(body["status"] == "no_match" and body["results"] == []
               and "couldn't find a matching specialist" in (body["message"] or ""),
               "CASE 9: no-match returns explained empty response via API")
    finally:
        matching_service._query_by_specialization = original_query

    def gp_only(db, specialization):  # noqa: ANN001
        if specialization == "Dentist":
            return []
        return original_query(db, specialization)

    matching_service._query_by_specialization = gp_only
    try:
        body = match("I have severe tooth pain").json()
        expect(body["status"] == "success"
               and body["message"] == matching_service.FALLBACK_MESSAGE
               and all(r["doctor"]["specialization"] == "General Physician"
                       for r in body["results"]),
               "CASE 9: GP fallback is explicitly marked, never silent")
    finally:
        matching_service._query_by_specialization = original_query

    # =====================================================================
    # CASE 10: emergency
    # =====================================================================
    body = match("I have crushing chest pain and I cannot breathe.").json()
    expect(body["status"] == "emergency" and body["results"] == []
           and body["total_results"] == 0,
           "CASE 10: emergency bypasses normal ranking entirely")
    expect("emergency" in (body["message"] or "").lower(),
           "CASE 10: response contains emergency guidance")
    expect(body["analysis"]["specialization"] == "General Physician"
           and body["analysis"]["urgency"] == "emergency",
           "CASE 10: no diagnosis made (GP + emergency only)")
    expect("you have a heart attack" not in json.dumps(body).lower()
           and "appendicitis" not in json.dumps(body).lower()
           and "pneumonia" not in json.dumps(body).lower(),
           "CASE 10: no disease names anywhere in the response")

    # =====================================================================
    # CASE 11: invalid location — all four bounds
    # =====================================================================
    for lat, lng, label in [(95, 0, "lat>90"), (-95, 0, "lat<-90"),
                            (0, 181, "lng>180"), (0, -181, "lng<-180")]:
        response = client.post("/match-doctors", json={
            "latitude": lat, "longitude": lng, "problem": "I have severe tooth pain"})
        expect(response.status_code == 422, f"CASE 11: {label} rejected (422)",
               f"got {response.status_code}")

    # =====================================================================
    # CASE 12: empty problem — rejected, AI never called
    # =====================================================================
    call_count = {"n": 0}

    class CountingProvider:
        name = "counting"

        def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
            call_count["n"] += 1
            raise AssertionError("AI must not be called")

    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(CountingProvider())
    try:
        response = client.post("/match-doctors", json={
            "latitude": LUCKNOW[0], "longitude": LUCKNOW[1], "problem": ""})
        expect(response.status_code == 422, "CASE 12: empty problem rejected (422)",
               f"got {response.status_code}")
        expect(call_count["n"] == 0, "CASE 12: AI was never called for invalid input")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # =====================================================================
    # CASE 13: AI failure — controlled response, no exception leakage
    # =====================================================================
    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(
        StubProvider(error=AIProviderError("simulated outage"))
    )
    try:
        response = match("I have a skin rash")
        expect(response.status_code == 200, "CASE 13: AI failure -> HTTP 200 (no crash)")
        body = response.json()
        expect(body["status"] == "success"
               and body["analysis"]["specialization"] == "Dermatologist",
               "CASE 13: deterministic keyword fallback used (per-problem specialty)")
        expect("AIProviderError" not in response.text
               and "Traceback" not in response.text
               and "simulated outage" not in response.text,
               "CASE 13: no raw provider exception exposed to the client")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    # =====================================================================
    # CASE 14: database failure — controlled 503, environment restored
    # =====================================================================
    def docker(action: str) -> bool:
        try:
            proc = subprocess.run(
                ["docker", action, "mediqo-postgres"],
                capture_output=True, text=True, timeout=60,
            )
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    db_restored = False
    try:
        expect(docker("stop"), "CASE 14: (fixture) PostgreSQL container stopped")
        time.sleep(2)

        response = match("I have severe tooth pain")
        expect(response.status_code == 503,
               "CASE 14: database outage -> controlled 503", f"got {response.status_code}")
        expect("Database temporarily unavailable" in response.text
               and "mediqo_dev" not in response.text
               and "psycopg" not in response.text
               and "Traceback" not in response.text,
               "CASE 14: no credentials or stack traces exposed")

        health = client.get("/health")
        expect(health.status_code == 200 and health.json() == {"status": "ok"},
               "CASE 14: /health stays healthy during DB outage")

        health_db = client.get("/health/db")
        expect(health_db.status_code == 503
               and health_db.json() == {"status": "error", "database": "unavailable"},
               "CASE 14: /health/db reports the outage cleanly")

        doctors_api = client.get("/doctors")
        expect(doctors_api.status_code == 503
               and "Traceback" not in doctors_api.text,
               "CASE 14: doctor API degrades cleanly too")
    finally:
        db_restored = docker("start")
        time.sleep(4)
        ready = subprocess.run(
            ["docker", "exec", "mediqo-postgres", "pg_isready", "-U", "mediqo"],
            capture_output=True, text=True, timeout=30,
        )
        expect(db_restored and ready.returncode == 0,
               "CASE 14: (fixture) PostgreSQL restored after the test")

    body = match("I have severe tooth pain").json()
    expect(body["status"] == "success" and body["total_results"] > 0,
           "CASE 14: matching fully recovered after DB restore")

    # =====================================================================
    # CASE 15: matching -> doctor profile -> reviews
    # =====================================================================
    body = match("I have severe tooth pain").json()
    doctor_id = body["results"][0]["doctor"]["id"]
    matched = body["results"][0]["doctor"]

    profile_response = client.get(f"/doctors/{doctor_id}")
    profile = profile_response.json()
    expect(profile_response.status_code == 200, "CASE 15: GET /doctors/{id} works from a match")
    expect(profile["id"] == doctor_id and profile["name"] == matched["name"]
           and profile["specialization"] == matched["specialization"]
           and profile["rating"] == matched["rating"]
           and profile["consultation_fee"] == matched["consultation_fee"],
           "CASE 15: profile matches the matched doctor exactly")
    expect(profile["languages"] == matched["languages"]
           and profile["availability"] == matched["availability"],
           "CASE 15: profile detail (languages/availability) matches")

    reviews_response = client.get(f"/doctors/{doctor_id}/reviews")
    reviews = reviews_response.json()
    expect(reviews_response.status_code == 200
           and reviews["doctor_id"] == doctor_id,
           "CASE 15: GET /doctors/{id}/reviews works from the profile")
    session = SessionLocal()
    try:
        db_review_ids = set(session.scalars(
            select(Review.id).where(Review.doctor_id == doctor_id)
        ).all())
    finally:
        session.close()
    expect({r["id"] for r in reviews["reviews"]} <= db_review_ids,
           "CASE 15: every review belongs to the matched doctor (DB-verified)")
    expect(reviews["total"] == matched["review_count"],
           "CASE 15: review total equals the doctor's review_count")

    # =====================================================================
    # DATA INTEGRITY across the whole demo database
    # =====================================================================
    session = SessionLocal()
    try:
        doctors = session.scalars(select(Doctor)).all()
        reviews = session.scalars(select(Review)).all()

        expect(all(-90 <= d.latitude <= 90 and -180 <= d.longitude <= 180 for d in doctors),
               "INTEGRITY: all doctors have valid coordinates")
        from app.schemas.matching import SUPPORTED_SPECIALIZATIONS

        expect(all(d.specialization in SUPPORTED_SPECIALIZATIONS
                   for d in doctors),
               "INTEGRITY: all specializations are supported values")
        expect(all(d.languages for d in doctors), "INTEGRITY: all doctors have languages")
        expect(all(d.availability for d in doctors), "INTEGRITY: all doctors have availability")
        expect(all(0 <= float(d.rating) <= 5 and d.review_count >= 0 for d in doctors),
               "INTEGRITY: all ratings valid")
        expect(all(d.is_demo for d in doctors) and all(r.is_demo for r in reviews),
               "INTEGRITY: every seeded record is marked is_demo=true")
        doctor_ids = {d.id for d in doctors}
        expect(all(r.doctor_id in doctor_ids for r in reviews),
               "INTEGRITY: no orphan reviews")
        from app.seed import DOCTOR_ENTRIES

        expect(len(doctors) == len(DOCTOR_ENTRIES),
               "INTEGRITY: dataset intact (every dataset doctor present)",
               f"got {len(doctors)}/{len(DOCTOR_ENTRIES)}")
    finally:
        session.close()

    # =====================================================================
    # API documentation
    # =====================================================================
    openapi = client.get("/openapi.json").json()
    expect(EXPECTED_OPENAPI_PATHS <= set(openapi["paths"]),
           "DOCS: all nine endpoint groups documented",
           f"missing: {sorted(EXPECTED_OPENAPI_PATHS - set(openapi['paths']))}")
    schemas = set(openapi.get("components", {}).get("schemas", {}))
    expect({"MatchRequest", "MatchResponse", "DoctorSummary", "MedicalProblemAnalysis"} <= schemas,
           "DOCS: request/response schemas appear in Swagger")
    expect(client.get("/docs").status_code == 200, "DOCS: /docs served")

    # =====================================================================
    # PERFORMANCE sanity: one AI call per request, quick completion
    # =====================================================================
    call_count = {"n": 0}

    class CountingAI:
        name = "counting-ai"

        def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
            call_count["n"] += 1
            return MedicalProblemAnalysis(
                specialization="Dentist", urgency="normal",
                summary="A dental evaluation may be appropriate.",
            )

    app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(CountingAI())
    try:
        started = time.perf_counter()
        response = match("I have severe tooth pain")
        elapsed = time.perf_counter() - started
        expect(call_count["n"] == 1, "PERF: exactly one AI analysis per match request",
               f"calls={call_count['n']}")
        expect(elapsed < 5.0, "PERF: match completes in a reasonable time",
               f"{elapsed * 1000:.0f} ms")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 64)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} end-to-end checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All end-to-end checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
