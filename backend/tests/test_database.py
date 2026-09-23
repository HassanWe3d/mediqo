"""Mediqo — Step 2 database verification script.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_database.py

Confirms that the backend can actually talk to PostgreSQL (real queries —
not just an env-var check), that the Step 2 schema exists with the expected
columns / types / foreign key, and that the Doctor -> Review relationship
works at the ORM level.

No data is persisted: ORM tests run inside a transaction that is always
rolled back, and a final row-count check proves the tables are still empty
(seeding happens in Step 3).
"""

import sys
from decimal import Decimal
from pathlib import Path

# Allow `python tests/test_database.py` from backend/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal, engine
from app.models import Doctor, Review  # noqa: F401 — registers models

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def test_connectivity() -> None:
    """Real database round-trip via the engine and via a session."""
    try:
        with engine.connect() as connection:
            value = connection.execute(text("SELECT 1")).scalar_one()
        expect(value == 1, "PostgreSQL connectivity via engine (SELECT 1)")
    except Exception as exc:  # noqa: BLE001
        expect(False, "PostgreSQL connectivity via engine (SELECT 1)", repr(exc))
        return

    try:
        session = SessionLocal()
        value = session.execute(text("SELECT 2")).scalar_one()
        session.close()
        expect(value == 2, "SessionLocal session executes queries")
    except Exception as exc:  # noqa: BLE001
        expect(False, "SessionLocal session executes queries", repr(exc))


def test_schema() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    expect("doctors" in tables, "Table 'doctors' exists", f"tables: {sorted(tables)}")
    expect("reviews" in tables, "Table 'reviews' exists", f"tables: {sorted(tables)}")
    if not {"doctors", "reviews"} <= tables:
        return

    expected_doctor_cols = {
        "id", "name", "specialization", "qualification", "experience_years",
        "languages", "consultation_fee", "clinic_name", "address", "city",
        "latitude", "longitude", "availability", "bio", "profile_image",
        "rating", "review_count", "verified", "is_demo", "created_at", "updated_at",
    }
    doctor_cols = {column["name"] for column in inspector.get_columns("doctors")}
    expect(
        expected_doctor_cols <= doctor_cols,
        "doctors columns match the Step 2 spec (all 21 present)",
        f"missing: {sorted(expected_doctor_cols - doctor_cols)}",
    )

    expected_review_cols = {
        "id", "doctor_id", "reviewer_name", "rating", "comment",
        "created_at", "verified_visit", "is_demo",
    }
    review_cols = {column["name"] for column in inspector.get_columns("reviews")}
    expect(
        expected_review_cols <= review_cols,
        "reviews columns match the Step 2 spec (all 8 present)",
        f"missing: {sorted(expected_review_cols - review_cols)}",
    )

    d = {column["name"]: column for column in inspector.get_columns("doctors")}
    expect(
        "NUMERIC(10, 2)" in str(d["consultation_fee"]["type"]).upper(),
        "consultation_fee is NUMERIC(10,2) — money-safe",
        f"got: {d['consultation_fee']['type']}",
    )
    expect(
        "NUMERIC(2, 1)" in str(d["rating"]["type"]).upper(),
        "rating is NUMERIC(2,1) — supports values like 4.7",
        f"got: {d['rating']['type']}",
    )
    expect(
        "DOUBLE PRECISION" in str(d["latitude"]["type"]).upper()
        and "DOUBLE PRECISION" in str(d["longitude"]["type"]).upper(),
        "latitude/longitude are double precision floats",
    )
    expect(
        isinstance(d["languages"]["type"], ARRAY),
        "languages is a PostgreSQL ARRAY",
        f"got: {d['languages']['type']!r}",
    )
    expect(
        "JSONB" in str(d["availability"]["type"]).upper(),
        "availability is JSONB (structured schedule)",
        f"got: {d['availability']['type']}",
    )
    r = {column["name"]: column for column in inspector.get_columns("reviews")}

    def server_default(column: dict) -> object:
        # SQLAlchemy exposes the DB-side default under "default" (PG dialect);
        # newer versions may use "server_default". Accept either.
        return column.get("server_default") or column.get("default")

    expect(
        server_default(d["created_at"]) is not None
        and server_default(d["updated_at"]) is not None,
        "doctors.created_at / updated_at have server defaults",
        f"created_at: {server_default(d['created_at'])!r}",
    )
    expect(
        "true" in str(server_default(d["is_demo"])).lower(),
        "doctors.is_demo defaults to true (MVP seed policy)",
        f"got: {server_default(d['is_demo'])!r}",
    )
    expect(
        server_default(r["created_at"]) is not None
        and "true" in str(server_default(r["is_demo"])).lower(),
        "reviews.created_at / is_demo have server defaults",
        f"is_demo: {server_default(r['is_demo'])!r}",
    )

    foreign_keys = inspector.get_foreign_keys("reviews")
    fk_ok = any(
        fk.get("referred_table") == "doctors"
        and fk.get("constrained_columns") == ["doctor_id"]
        and fk.get("referred_columns") == ["id"]
        for fk in foreign_keys
    )
    expect(
        fk_ok,
        "reviews.doctor_id is a foreign key -> doctors.id",
        f"fks: {foreign_keys}",
    )


def test_orm_relationship() -> None:
    """Doctor <-> Review relationship + cascade, inside a rolled-back transaction."""
    session = SessionLocal()
    try:
        doctor = Doctor(
            name="__rel_test_doctor__",
            specialization="Gastroenterologist",
            qualification="MBBS, MD",
            experience_years=8,
            languages=["English", "Hindi"],
            consultation_fee=Decimal("600.00"),
            clinic_name="MediCare Clinic",
            address="1 Test Street",
            city="Lucknow",
            latitude=26.8467,
            longitude=80.9462,
            availability={
                "mon": [["16:00", "20:00"]],
                "tue": [["16:00", "20:00"]],
                "wed": [["16:00", "20:00"]],
                "thu": [["16:00", "20:00"]],
                "fri": [["16:00", "20:00"]],
                "sat": [["16:00", "20:00"]],
            },
            rating=Decimal("4.7"),
        )
        session.add(doctor)
        session.flush()  # assigns id — still uncommitted

        review = Review(
            doctor=doctor,
            reviewer_name="__rel_test_reviewer__",
            rating=5,
            comment="relationship test",
            verified_visit=True,
        )
        session.add(review)
        session.flush()

        expect(
            doctor.id is not None and review.doctor_id == doctor.id,
            "Review.doctor_id populated from Doctor relationship",
        )
        expect(
            len(doctor.reviews) == 1 and doctor.reviews[0].comment == "relationship test",
            "Doctor.reviews returns related reviews",
        )
        expect(review.doctor is doctor, "Review.doctor back-reference works")
        expect(
            isinstance(doctor.consultation_fee, Decimal) and isinstance(doctor.rating, Decimal),
            "NUMERIC columns round-trip as Decimal (money + rating)",
        )
        expect(
            doctor.availability_summary == "Mon–Sat 4 PM–8 PM",
            "availability_summary renders schedule ('Mon–Sat 4 PM–8 PM')",
            f"got: {doctor.availability_summary!r}",
        )

        session.delete(doctor)
        session.flush()
        remaining = session.query(Review).filter_by(reviewer_name="__rel_test_reviewer__").count()
        expect(remaining == 0, "Deleting a Doctor cascades to its Reviews (ORM-level)")
    except Exception as exc:  # noqa: BLE001
        expect(False, "Doctor <-> Review relationship (ORM)", repr(exc))
    finally:
        session.rollback()  # never persist test data
        session.close()


def test_rating_constraint() -> None:
    """The DB must reject review ratings outside 1–5."""
    session = SessionLocal()
    try:
        doctor = Doctor(
            name="__constraint_test_doctor__",
            specialization="Dentist",
            qualification="BDS",
            consultation_fee=Decimal("500.00"),
            clinic_name="Test Clinic",
            address="1 Test Street",
            city="Lucknow",
            latitude=26.85,
            longitude=80.95,
        )
        session.add(doctor)
        session.flush()
        session.add(Review(doctor_id=doctor.id, reviewer_name="x", rating=6))
        session.flush()
        expect(False, "reviews.rating CHECK (1–5) rejects out-of-range values", "rating=6 accepted")
    except IntegrityError:
        expect(True, "reviews.rating CHECK (1–5) rejects out-of-range values")
    except Exception as exc:  # noqa: BLE001
        expect(False, "reviews.rating CHECK (1–5) rejects out-of-range values", repr(exc))
    finally:
        session.rollback()
        session.close()


def test_demo_dataset_present() -> None:
    """Step 2 required EMPTY tables ("no seeding during Step 2").

    From Step 3 onwards the MVP database holds the demo dataset, so this
    guard became: only demo data exists, in the expected MVP range.
    Detailed dataset checks live in tests/test_seed.py.
    """
    with engine.connect() as connection:
        doctors = connection.execute(text("SELECT COUNT(*) FROM doctors")).scalar_one()
        reviews = connection.execute(text("SELECT COUNT(*) FROM reviews")).scalar_one()
    expect(
        30 <= doctors <= 50 and doctors * 2 <= reviews <= doctors * 5,
        "Database holds the Step 3 demo dataset (30-50 doctors, 2-5 reviews each)",
        f"doctors={doctors}, reviews={reviews}",
    )


def main() -> int:
    print("Mediqo Step 2 — database verification")
    print("=" * 60)
    test_connectivity()
    test_schema()
    test_orm_relationship()
    test_rating_constraint()
    test_demo_dataset_present()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All database checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
