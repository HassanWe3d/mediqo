"""Mediqo — Step 3 seed verification script.

Run from the backend/ directory (requires the seed to have been run once):

    .venv/Scripts/python.exe tests/test_seed.py

Verifies the demo dataset: counts, demo flags, foreign keys, field
completeness, rating consistency, availability contract, and that running
the seed again is idempotent (no duplicates).
"""

import sys
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import Doctor, Review
from app.seed import seed_demo_data

VALID_DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def main() -> int:
    print("Mediqo Step 3 — demo seed verification")
    print("=" * 60)

    session = SessionLocal()
    doctors = session.scalars(select(Doctor)).all()
    reviews = session.scalars(select(Review)).all()

    # 1. Counts (dataset expanded across India; keep a generous upper bound)
    expect(100 <= len(doctors) <= 250, "Doctor count within expanded demo range 100-250", f"got {len(doctors)}")
    expect(len(reviews) >= 2 * len(doctors), "Reviews exist (>= 2 per doctor overall)",
           f"got {len(reviews)} for {len(doctors)} doctors")

    # 2. Demo flags
    expect(all(doctor.is_demo for doctor in doctors), "Every doctor has is_demo = true")
    expect(all(review.is_demo for review in reviews), "Every review has is_demo = true")
    expect(all(not doctor.verified for doctor in doctors),
           "No demo doctor is marked 'verified' (credential verification is future work)")

    # 3. Foreign keys
    doctor_ids = {doctor.id for doctor in doctors}
    orphans = [review for review in reviews if review.doctor_id not in doctor_ids]
    expect(not orphans, "Every review references a valid doctor (no orphans)",
           f"{len(orphans)} orphans")

    # 4. Required fields populated
    def missing(doctor: Doctor) -> bool:
        return (
            not doctor.name or not doctor.specialization or not doctor.qualification
            or not doctor.clinic_name or not doctor.address or not doctor.city
            or doctor.latitude is None or doctor.longitude is None
            or not doctor.languages or not doctor.availability
            or doctor.consultation_fee is None or doctor.consultation_fee <= 0
        )

    incomplete = [doctor.name for doctor in doctors if missing(doctor)]
    expect(not incomplete, "No required doctor fields empty (name, specialty, coords, languages, availability, fee)",
           f"e.g. {incomplete[:3]}")

    # 5. Ratings valid
    expect(all(1 <= review.rating <= 5 for review in reviews), "All review ratings within 1-5")
    expect(all(Decimal("0") <= doctor.rating <= Decimal("5") for doctor in doctors),
           "All doctor ratings within 0-5")
    ratings = {float(doctor.rating) for doctor in doctors}
    expect(len(ratings) >= 5, "Rating values are varied (not everyone identical)",
           f"values: {sorted(ratings)}")

    # 6. Per-doctor review counts + rating consistency
    by_doctor: dict[int, list[int]] = defaultdict(list)
    for review in reviews:
        by_doctor[review.doctor_id].append(review.rating)
    expect(
        all(2 <= len(by_doctor.get(doctor.id, [])) <= 5 for doctor in doctors),
        "Each doctor has 2-5 demo reviews",
    )
    consistent = all(
        doctor.review_count == len(by_doctor.get(doctor.id, []))
        and doctor.rating
        == (Decimal(sum(by_doctor[doctor.id])) / Decimal(len(by_doctor[doctor.id]))).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP
        )
        for doctor in doctors
    )
    expect(consistent, "doctor.review_count and rating match the seeded reviews (half-up, like SQL ROUND)")

    # 7. Availability contract
    def availability_ok(doctor: Doctor) -> bool:
        if not isinstance(doctor.availability, dict) or not set(doctor.availability) <= VALID_DAYS:
            return False
        return all(
            isinstance(interval, list) and len(interval) == 2
            for intervals in doctor.availability.values()
            for interval in intervals
        )

    expect(all(availability_ok(doctor) for doctor in doctors),
           "Availability JSONB matches the schema contract (day -> [[start, end]])")

    # 8. Availability differentiation (matching must be able to say "not available today")
    off_counts = {
        day: sum(1 for doctor in doctors if not doctor.availability.get(day))
        for day in ("mon", "tue", "wed", "thu", "fri", "sat")
    }
    expect(min(off_counts.values()) >= 3,
           "Every weekday Mon-Sat has several doctors OFF (differentiated availability)",
           f"off counts: {off_counts}")

    # 9. Geographic spread: Lucknow remains the deepest market, with
    # meaningful multi-region coverage so matching differs per city.
    cities = {doctor.city for doctor in doctors}
    expect("Lucknow" in cities and len(cities) >= 10,
           "Multi-city coverage with Lucknow as the deepest market", f"cities: {sorted(cities)}")
    lucknow = sum(1 for doctor in doctors if doctor.city == "Lucknow")
    expect(lucknow >= 30, "Lucknow has the bulk of doctors (>= 30)", f"got {lucknow}")
    for metro in ("Delhi", "Mumbai", "Bengaluru"):
        expect(metro in cities, f"Metro market present: {metro}")
    kerala = {"Kochi", "Thiruvananthapuram", "Kozhikode"}
    expect(kerala <= cities, "Kerala cities present (Kochi, Thiruvananthapuram, Kozhikode)",
           f"missing: {sorted(kerala - cities)}")

    # 10. Idempotency — running the seed again must not duplicate anything
    before = (
        session.scalar(select(func.count()).select_from(Doctor)),
        session.scalar(select(func.count()).select_from(Review)),
    )
    outcome = seed_demo_data(session)
    after = (
        session.scalar(select(func.count()).select_from(Doctor)),
        session.scalar(select(func.count()).select_from(Review)),
    )
    expect(outcome is None and before == after,
           "Seed rerun is idempotent (skipped, no duplicates)",
           f"before={before}, after={after}, outcome={outcome}")

    session.close()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All seed checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
