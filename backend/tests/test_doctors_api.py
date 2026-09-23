"""Mediqo — Step 4 Doctor API verification script.

Run from the backend/ directory (requires the Step 3 seed to be present):

    .venv/Scripts/python.exe tests/test_doctors_api.py

Uses FastAPI's TestClient against the real PostgreSQL database (read-only —
these endpoints never write). Expected counts are computed from the database
itself, so the tests do not hardcode seed values.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.database import SessionLocal
from app.main import app
from app.models import Doctor, Review

client = TestClient(app)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def db_count(model, *filters) -> int:
    session = SessionLocal()
    try:
        query = select(func.count()).select_from(model)
        if filters:
            query = query.where(*filters)
        return session.scalar(query) or 0
    finally:
        session.close()


def main() -> int:
    print("Mediqo Step 4 — Doctor API verification")
    print("=" * 60)

    # 1. GET /doctors — 200 + envelope
    response = client.get("/doctors")
    expect(response.status_code == 200, "GET /doctors returns 200")
    body = response.json()
    expect(
        {"items", "page", "page_size", "total", "pages"} <= set(body),
        "List response envelope has items/page/page_size/total/pages",
    )
    expect(
        all(item["is_demo"] for item in body["items"]),
        "Listed doctors expose is_demo=true (demo data is not hidden)",
    )
    expected_total = db_count(Doctor)
    expect(body["total"] == expected_total, "total matches PostgreSQL count",
           f"api={body['total']}, db={expected_total}")
    expect(
        all({"name", "specialization", "rating", "consultation_fee", "latitude", "longitude"} <= set(item)
            for item in body["items"]),
        "Doctor list items contain the profile fields clients need",
    )

    # 2. Pagination
    page1 = client.get("/doctors", params={"page": 1, "page_size": 5}).json()
    page2 = client.get("/doctors", params={"page": 2, "page_size": 5}).json()
    expect(len(page1["items"]) == 5 and len(page2["items"]) == 5,
           "Pagination returns page_size items per page")
    expect({i["id"] for i in page1["items"]}.isdisjoint({i["id"] for i in page2["items"]}),
           "Page 2 contains different doctors than page 1")
    expect(page1["total"] == page2["total"] == expected_total,
           "total is stable across pages")
    expect(page1["pages"] == (expected_total + 4) // 5, "pages computed correctly")

    # 3. page_size limits
    expect(client.get("/doctors", params={"page_size": 51}).status_code == 422,
           "page_size above 50 rejected (422)")
    expect(client.get("/doctors", params={"page_size": 50, "page": 1}).status_code == 200,
           "page_size 50 accepted")
    expect(client.get("/doctors", params={"page": 0}).status_code == 422,
           "page below 1 rejected (422)")
    expect(client.get("/doctors", params={"page_size": 0}).status_code == 422,
           "page_size below 1 rejected (422)")

    # 4. Specialization filter (case-insensitive, DB-level)
    expected_dentists = db_count(Doctor, func.lower(Doctor.specialization) == "dentist")
    for label, value in (("lowercase", "dentist"), ("uppercase", "DENTIST")):
        response = client.get("/doctors", params={"specialization": value})
        data = response.json()
        expect(
            response.status_code == 200
            and data["total"] == expected_dentists
            and all(i["specialization"] == "Dentist" for i in data["items"]),
            f"specialization filter works, case-insensitive ({label})",
            f"api={data['total']}, db={expected_dentists}",
        )

    # 5. City filter
    expected_lucknow = db_count(Doctor, func.lower(Doctor.city) == "lucknow")
    response = client.get("/doctors", params={"city": "lucknow"})
    data = response.json()
    expect(
        response.status_code == 200 and data["total"] == expected_lucknow
        and all(i["city"] == "Lucknow" for i in data["items"]),
        "city filter works, case-insensitive",
        f"api={data['total']}, db={expected_lucknow}",
    )

    # 6. Combined filters
    expected_combined = db_count(
        Doctor,
        func.lower(Doctor.city) == "lucknow",
        func.lower(Doctor.specialization) == "general physician",
    )
    response = client.get("/doctors", params={"city": "Lucknow", "specialization": "General Physician"})
    data = response.json()
    expect(
        response.status_code == 200 and data["total"] == expected_combined
        and all(i["city"] == "Lucknow" and i["specialization"] == "General Physician" for i in data["items"]),
        "combined specialization + city filter works",
        f"api={data['total']}, db={expected_combined}",
    )

    # 7. Doctor detail
    session = SessionLocal()
    try:
        first_doctor = session.scalar(select(Doctor).order_by(Doctor.id).limit(1))
        doctor_id = first_doctor.id
        db_name = first_doctor.name
        db_rating = float(first_doctor.rating)
    finally:
        session.close()
    response = client.get(f"/doctors/{doctor_id}")
    detail = response.json()
    expect(response.status_code == 200, "GET /doctors/{id} returns 200")
    expect(detail["id"] == doctor_id and detail["name"] == db_name and detail["rating"] == db_rating,
           "Detail returns the correct doctor from PostgreSQL",
           f"api={detail.get('name')}, db={db_name}")
    expect("availability_summary" in detail and "created_at" in detail,
           "Detail includes availability_summary and timestamps")

    # 8. Detail — not found
    response = client.get("/doctors/999999")
    expect(response.status_code == 404 and response.json()["detail"] == "Doctor not found",
           "Nonexistent doctor returns 404 with clean message",
           f"got {response.status_code} {response.text[:80]}")

    # 9. Reviews endpoint
    expected_reviews = db_count(Review, Review.doctor_id == doctor_id)
    response = client.get(f"/doctors/{doctor_id}/reviews")
    reviews_body = response.json()
    expect(response.status_code == 200, "GET /doctors/{id}/reviews returns 200")
    expect(reviews_body["doctor_id"] == doctor_id
           and reviews_body["total"] == expected_reviews
           and len(reviews_body["reviews"]) == min(expected_reviews, 10),
           "Reviews envelope: correct doctor, total, page slice",
           f"api_total={reviews_body['total']}, db={expected_reviews}")

    # 10. Reviews belong to the requested doctor only
    session = SessionLocal()
    try:
        db_review_ids = set(
            session.scalars(select(Review.id).where(Review.doctor_id == doctor_id)).all()
        )
    finally:
        session.close()
    api_review_ids = {review["id"] for review in reviews_body["reviews"]}
    expect(api_review_ids <= db_review_ids,
           "All returned reviews belong to the requested doctor")
    expect(all(review["is_demo"] for review in reviews_body["reviews"]),
           "Returned reviews expose is_demo=true")

    # 11. Reviews — doctor not found
    expect(client.get("/doctors/999999/reviews").status_code == 404,
           "Reviews for nonexistent doctor return 404")

    # 12. Invalid IDs
    expect(client.get("/doctors/0").status_code == 422, "Doctor id 0 rejected (422)")
    expect(client.get("/doctors/abc").status_code == 422, "Non-integer doctor id rejected (422)")

    # 13. Swagger / OpenAPI
    expect(client.get("/docs").status_code == 200, "Swagger UI (/docs) is served")
    openapi = client.get("/openapi.json").json()
    expected_paths = {"/doctors", "/doctors/{doctor_id}", "/doctors/{doctor_id}/reviews"}
    expect(expected_paths <= set(openapi["paths"]),
           "OpenAPI documents all doctor endpoints", f"paths: {sorted(openapi['paths'])}")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All Doctor API checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
