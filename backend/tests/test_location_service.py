"""Mediqo — Step 6 location verification script.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_location_service.py

Covers coordinate validation, the Haversine distance function, manual city
resolution, and the /location/* API endpoints. No external geocoding, no
coordinate persistence.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.schemas.location import LocationInput, ManualLocationInput
from app.services.location_service import (
    calculate_distance,
    get_supported_cities,
    resolve_city,
    validate_coordinates,
)

client = TestClient(app)

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


def accepts(lat: float, lng: float) -> bool:
    try:
        LocationInput(latitude=lat, longitude=lng)
        return True
    except ValidationError:
        return False


def main() -> int:
    print("Mediqo Step 6 — location verification")
    print("=" * 60)

    # ---- 1-9. Coordinate validation (service helper) ----
    expect(validate_coordinates(26.8467, 80.9462), "Valid Lucknow coordinates accepted")
    expect(validate_coordinates(-90, 0) and validate_coordinates(90, 0),
           "Latitude boundaries -90 / 90 accepted")
    expect(validate_coordinates(0, -180) and validate_coordinates(0, 180),
           "Longitude boundaries -180 / 180 accepted")
    expect(not validate_coordinates(90.0001, 0), "Latitude > 90 rejected")
    expect(not validate_coordinates(-90.0001, 0), "Latitude < -90 rejected")
    expect(not validate_coordinates(0, 180.0001), "Longitude > 180 rejected")
    expect(not validate_coordinates(0, -180.0001), "Longitude < -180 rejected")
    expect(not validate_coordinates(float("nan"), 0), "NaN latitude rejected")

    # ---- Schema-level validation (what the API enforces) ----
    expect(accepts(26.8467, 80.9462), "LocationInput accepts valid coordinates")
    for lat, lng, label in [(-90, 0, "lat=-90"), (90, 0, "lat=90"),
                            (0, -180, "lng=-180"), (0, 180, "lng=180")]:
        expect(accepts(lat, lng), f"LocationInput accepts boundary ({label})")
    for lat, lng, label in [(90.5, 0, "lat>90"), (-90.5, 0, "lat<-90"),
                            (0, 180.5, "lng>180"), (0, -180.5, "lng<-180")]:
        expect(not accepts(lat, lng), f"LocationInput rejects ({label})")
    expect(not accepts(float("nan"), 0), "LocationInput rejects NaN latitude")

    # ---- 10-11. Distance calculation (Haversine) ----
    d_same = calculate_distance(26.8467, 80.9462, 26.8467, 80.9462)
    expect(abs(d_same) < 0.001, "Same coordinates -> distance ~0 km", f"got {d_same}")

    d_lko_knp = calculate_distance(26.8467, 80.9462, 26.4499, 80.3329)  # Lucknow -> Kanpur
    expect(70 < d_lko_knp < 80, "Lucknow -> Kanpur is ~75 km (within tolerance)",
           f"got {d_lko_knp:.1f} km")

    d_nearby = calculate_distance(26.8467, 80.9462, 26.8565, 80.9880)  # Hazratganj -> Gomti Nagar
    expect(3.5 < d_nearby < 5.0, "Hazratganj -> Gomti Nagar is ~4.3 km",
           f"got {d_nearby:.2f} km")

    a, b = (26.8467, 80.9462), (26.4499, 80.3329)
    expect(calculate_distance(*a, *b) == calculate_distance(*b, *a),
           "Distance is symmetric")

    # Distances from the Lucknow center to seeded doctors span a useful range
    d_unnao = calculate_distance(26.8467, 80.9462, 26.5480, 80.3650)  # Unnao doctor
    expect(60 < d_unnao < 70, "Lucknow -> Unnao doctor is ~66 km (far-away behaviour)",
           f"got {d_unnao:.1f} km")

    # ---- 12-15. Manual city resolution ----
    session_ok = None  # resolve_city needs a DB session; use SessionLocal
    from app.database import SessionLocal
    session = SessionLocal()
    try:
        resolution = resolve_city("Lucknow", session)
        expect(resolution is not None and resolution.city == "Lucknow",
               "Manual 'Lucknow' resolves with canonical name")
        expect(resolution is not None and 25 < resolution.latitude < 28,
               "Resolved city carries plausible center coordinates")

        expect(resolve_city("lucknow", session) is not None,
               "City resolution is case-insensitive")
        expect(resolve_city("  lucknow  ", session) is not None,
               "City resolution tolerates surrounding whitespace")
        expect(resolve_city("Delhi", session) is None,
               "Unsupported city ('Delhi' — no doctors) is rejected")
        expect(resolve_city("", session) is None, "Empty city is rejected")

        cities = get_supported_cities(session)
        city_names = [name for name, _ in cities]
        expect(city_names[0] == "Lucknow" and dict(cities)["Lucknow"] == 40,
               "Supported cities list is DB-driven, Lucknow first with 40 doctors",
               f"got {cities}")
    finally:
        session.close()

    # ---- API: POST /location/validate ----
    response = client.post("/location/validate",
                           json={"latitude": 26.8467, "longitude": 80.9462})
    expect(response.status_code == 200
           and response.json() == {"valid": True, "latitude": 26.8467, "longitude": 80.9462},
           "POST /location/validate returns 200 with echoed coordinates",
           f"got {response.status_code} {response.text[:100]}")
    expect(client.post("/location/validate", json={"latitude": 95, "longitude": 0}).status_code == 422,
           "POST /location/validate rejects lat>90 (422)")
    expect(client.post("/location/validate", json={"latitude": 0, "longitude": -200}).status_code == 422,
           "POST /location/validate rejects lng<-180 (422)")
    expect(client.post("/location/validate", json={"latitude": "abc", "longitude": 0}).status_code == 422,
           "POST /location/validate rejects non-numeric input (422)")

    # ---- API: POST /location/manual ----
    response = client.post("/location/manual", json={"city": "Lucknow"})
    body = response.json()
    expect(response.status_code == 200 and body["valid"] is True and body["city"] == "Lucknow",
           "POST /location/manual resolves Lucknow", f"got {response.text[:120]}")
    expect(body.get("latitude") is not None and body.get("longitude") is not None,
           "Manual response includes city-center coordinates for matching")
    response = client.post("/location/manual", json={"city": " lucknow "})
    expect(response.status_code == 200, "Manual endpoint is case/space tolerant")
    response = client.post("/location/manual", json={"city": "Delhi"})
    expect(response.status_code == 400
           and response.json()["detail"] == "This location is not currently supported.",
           "Unsupported city returns clean 400 with the spec message",
           f"got {response.status_code} {response.text[:120]}")
    expect(client.post("/location/manual", json={"city": ""}).status_code == 422,
           "Empty city returns 422")

    # ---- API: GET /location/cities ----
    response = client.get("/location/cities")
    cities = response.json()
    expect(response.status_code == 200 and cities[0]["city"] == "Lucknow"
           and cities[0]["doctor_count"] == 40,
           "GET /location/cities returns DB-driven city list",
           f"got {response.text[:160]}")
    expect(all(c["latitude"] is not None for c in cities),
           "All supported cities carry center coordinates")

    # ---- OpenAPI ----
    openapi = client.get("/openapi.json").json()
    expect({"/location/validate", "/location/manual", "/location/cities"} <= set(openapi["paths"]),
           "OpenAPI documents all location endpoints")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All location checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
