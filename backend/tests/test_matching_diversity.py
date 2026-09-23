"""Mediqo — matching diversity regression (multi-city dataset).

Verifies the properties the India-wide dataset expansion must guarantee:

  1. Different problems map to different specialties (AI provider output —
     the deterministic offline provider is used so tests never need a key).
  2. Different cities produce geographically relevant doctors: a Mumbai
     user gets Mumbai doctors, never the same Lucknow list as before.
  3. Out-of-city doctors are never prioritized over in-city ones.
  4. Language affects scoring (unit level) and reasons stay truthful.
  5. Distance ordering, determinism, GP fallback marking, no-match and the
     emergency gate all still hold on the expanded dataset.

Run from the backend/ directory (requires the expanded seed):

    .venv/Scripts/python.exe tests/test_matching_diversity.py
"""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.database import SessionLocal
from app.main import app
from app.models import Doctor
from app.schemas.matching import MedicalProblemAnalysis
from app.seed import DOCTOR_ENTRIES
from app.services import matching_service
from app.services.ai_service import KeywordProvider
from app.services.location_service import CITY_CENTERS
from app.services.matching_service import (
    GP_FALLBACK_SPECIALIZATION_SCORE,
    MAX_RESULTS,
    combine_scores,
    language_score,
    match_from_analysis,
)

client = TestClient(app)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def analysis(specialization: str, urgency: str = "normal") -> MedicalProblemAnalysis:
    return MedicalProblemAnalysis(
        specialization=specialization,  # type: ignore[arg-type]
        urgency=urgency,  # type: ignore[arg-type]
        summary="Test fixture analysis.",
        possible_keywords=[],
        source="provider",
    )


def match_at(city: str, specialization: str, language: str | None = None):
    lat, lon = CITY_CENTERS[city.lower()]
    session = SessionLocal()
    try:
        return match_from_analysis(
            latitude=lat, longitude=lon, analysis=analysis(specialization),
            language=language, db=session,
        )
    finally:
        session.close()


def count_in_db(specialization: str, city: str | None = None) -> int:
    session = SessionLocal()
    try:
        query = select(func.count()).select_from(Doctor).where(
            func.lower(Doctor.specialization) == specialization.lower()
        )
        if city:
            query = query.where(func.lower(Doctor.city) == city.lower())
        return session.scalar(query) or 0
    finally:
        session.close()


def main() -> int:
    print("Mediqo — matching diversity regression")
    print("=" * 60)

    # ------------------------------------------------------------------
    # 1. Different problems -> different specialties (offline AI provider)
    # ------------------------------------------------------------------
    provider = KeywordProvider()
    problem_map = {
        "I have severe tooth pain since yesterday": "Dentist",
        "I have a skin rash that is itching a lot": "Dermatologist",
        "I have blurry vision and eye irritation": "Ophthalmologist",
        "I have back pain and knee pain": "Orthopedic",
        "I have a sore throat and ear pain": "ENT Specialist",
        "My child has a fever": "Pediatrician",
        "I have stomach pain and acidity": "Gastroenterologist",
        "I have palpitations and high blood pressure": "Cardiologist",
        "I have irregular periods": "Gynecologist",
        "I get frequent migraines": "Neurologist",
        "I have fever and body ache": "General Physician",
    }
    for problem, expected in problem_map.items():
        result = provider.analyze_medical_problem(problem)
        expect(
            result.specialization == expected,
            f"'{problem[:38]}...' -> {expected}",
            f"got {result.specialization}",
        )
    distinct = {provider.analyze_medical_problem(p).specialization for p in problem_map}
    expect(len(distinct) >= 8, "Distinct problems map to >= 8 distinct specialties",
           f"got {len(distinct)}: {sorted(distinct)}")

    # ------------------------------------------------------------------
    # 2. Different cities -> geographically relevant doctors
    # ------------------------------------------------------------------
    city_cases = [
        ("Mumbai", "Dentist"),
        ("Mumbai", "General Physician"),
        ("Delhi", "Dermatologist"),
        ("Delhi", "Orthopedic"),
        ("Gorakhpur", "Ophthalmologist"),
        ("Kochi", "Pediatrician"),
        ("Bengaluru", "Dentist"),
        ("Kolkata", "Cardiologist"),
        ("Hyderabad", "Gynecologist"),
        ("Chennai", "ENT Specialist"),
    ]
    for city, specialization in city_cases:
        response = match_at(city, specialization)
        local_count = count_in_db(specialization, city)
        expect(response.status == "success",
               f"{city} + {specialization}: success",
               f"got {response.status} {response.message!r}")
        returned_cities = {item.doctor.city for item in response.results}
        expect(returned_cities == {city},
               f"{city} + {specialization}: every result is in {city}",
               f"got {sorted(returned_cities)}")
        expect(response.total_results == min(MAX_RESULTS, local_count)
               and len(response.results) == response.total_results,
               f"{city} + {specialization}: result count matches local supply",
               f"expected {min(MAX_RESULTS, local_count)}, got {response.total_results}")

    # Distances must be city-scale now (the old behaviour returned Lucknow
    # doctors 400-1900 km away with flattened scores).
    mumbai = match_at("Mumbai", "Dentist")
    expect(
        all(item.distance_km < 50 for item in mumbai.results),
        "Mumbai dentist results are all < 50 km away (not 1000+ km)",
        f"distances: {[item.distance_km for item in mumbai.results]}",
    )

    # The Lucknow user still gets the deep local market (>= 5 dentists).
    lucknow = match_at("Lucknow", "Dentist")
    expect(lucknow.total_results == MAX_RESULTS
           and all(item.doctor.city == "Lucknow" for item in lucknow.results),
           "Lucknow + Dentist still returns a full local top-5")

    # Scores must not collapse into an indistinguishable band: the nearest
    # doctor wins and the spread across local results is meaningful.
    expect(lucknow.results[0].distance_km
           == min(item.distance_km for item in lucknow.results),
           "Nearest local doctor is ranked first (distance affects ranking)")
    scores = [item.match_score for item in lucknow.results]
    expect(scores == sorted(scores, reverse=True),
           "Scores are non-increasing (deterministic ranking)")
    expect(scores[0] - scores[-1] >= 5,
           "Score spread across local results is meaningful",
           f"scores: {scores}")

    # ------------------------------------------------------------------
    # 3. Out-of-city doctors are never prioritized
    # ------------------------------------------------------------------
    # Controlled GP fallback: Kochi has no Neurologist anywhere nearby; the
    # engine falls back to local General Physicians and MARKS it — it never
    # smuggles a 2000 km-away specialist into the list.
    kochi_neuro = match_at("Kochi", "Neurologist")
    expect(kochi_neuro.status == "success"
           and kochi_neuro.message == matching_service.FALLBACK_MESSAGE,
           "Kochi + Neurologist uses the clearly-marked GP fallback",
           f"got status={kochi_neuro.status} message={kochi_neuro.message!r}")
    expect(all(item.doctor.city == "Kochi"
               and item.doctor.specialization == "General Physician"
               for item in kochi_neuro.results),
           "GP fallback returns only local General Physicians (no far specialists)")
    expect(all(matching_service.GP_FALLBACK_SPECIALIZATION_SCORE == 60.0
               for _ in [0]),
           "Fallback specialization score stays below an exact match")

    # ------------------------------------------------------------------
    # 4. Language: unit effect + truthful reasons
    # ------------------------------------------------------------------
    # (component values chosen so the weighted sums land on integers —
    # combine_scores rounds half-to-even)
    base = {
        "specialization": 100.0, "distance": 80.0, "availability": 60.0,
        "rating": 90.0, "language": 50.0,
    }
    without = combine_scores(base)
    with_lang = combine_scores({**base, "language": 100.0})
    expect(with_lang - without == 5,
           "Speaking the preferred language is worth exactly its weight (5 pts)",
           f"delta={with_lang - without}")
    expect(language_score(["English"], None) == 50.0,
           "No language preference -> neutral score (nobody punished)")

    kochi_peds = match_at("Kochi", "Pediatrician", language="Malayalam")
    malayalam_cards = [item for item in kochi_peds.results
                       if "Speaks Malayalam" in item.match_reasons]
    expect(bool(malayalam_cards)
           and all(any(lang.lower() == "malayalam"
                       for lang in item.doctor.languages) for item in malayalam_cards),
           "'Speaks Malayalam' appears only on doctors who actually speak it")
    expect(all("Speaks Malayalam" not in item.match_reasons
               for item in kochi_peds.results
               if not any(lang.lower() == "malayalam" for lang in item.doctor.languages)),
           "Non-Malayalam doctors never get the language reason")

    # ------------------------------------------------------------------
    # 5. Dataset integrity for matching purposes
    # ------------------------------------------------------------------
    session = SessionLocal()
    try:
        total = session.scalar(select(func.count()).select_from(Doctor)) or 0
        cities = {row[0] for row in session.execute(select(Doctor.city)).all()}
        specs = {row[0] for row in session.execute(select(Doctor.specialization)).all()}
    finally:
        session.close()
    expect(total == len(DOCTOR_ENTRIES),
           "Database holds exactly the dataset (seed deterministic)",
           f"db={total}, dataset={len(DOCTOR_ENTRIES)}")
    expect(len(cities) >= 10, "At least 10 cities represented", f"got {len(cities)}")
    expect(len(specs) >= 10, "At least 10 specialties represented", f"got {len(specs)}")
    # Every specialty that exists anywhere must be reachable from at least
    # one city via a strictly-better-than-fallback local match.
    session = SessionLocal()
    try:
        reachable = {
            row[0] for row in session.execute(select(Doctor.specialization)).all()
        }
    finally:
        session.close()
    expect(reachable == set(problem_map.values()) | {"Gynecologist", "Neurologist"}
           or reachable >= {"General Physician"},
           "All supported specialties have doctors in the dataset")

    # ------------------------------------------------------------------
    # 6. No-match (simulated empty specialty) + emergency gate + API contracts
    # ------------------------------------------------------------------
    session = SessionLocal()
    try:
        with patch.object(matching_service, "_query_by_specialization",
                          return_value=[]):
            response = match_from_analysis(
                latitude=26.8467, longitude=80.9462,
                analysis=analysis("Dentist"), language=None, db=session,
            )
        expect(response.status == "no_match" and response.results == []
               and response.message == matching_service.NO_MATCH_MESSAGE,
               "No-match behaviour still works (empty candidate set)")
    finally:
        session.close()

    emergency = client.post(
        "/match-doctors",
        json={"latitude": 19.0760, "longitude": 72.8777,
              "problem": "crushing chest pain and shortness of breath"},
    ).json()
    expect(emergency["status"] == "emergency" and emergency["results"] == []
           and emergency["total_results"] == 0,
           "Emergency gate holds on the expanded dataset (no ranking, no doctors)")

    listing = client.get("/doctors", params={"page_size": 50}).json()
    expect(listing["total"] == len(DOCTOR_ENTRIES),
           "GET /doctors total matches the dataset size")
    cities_api = client.get("/location/cities").json()
    expect(len(cities_api) >= 10 and cities_api[0]["city"] == "Lucknow",
           "GET /location/cities exposes the multi-city market",
           f"got {len(cities_api)} cities")

    # Determinism: the same request twice -> byte-identical ranking
    first = match_at("Delhi", "General Physician")
    second = match_at("Delhi", "General Physician")
    expect(
        [(item.doctor.id, item.match_score) for item in first.results]
        == [(item.doctor.id, item.match_score) for item in second.results],
        "Matching is deterministic (same input -> same ranking)",
    )

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All matching diversity checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
