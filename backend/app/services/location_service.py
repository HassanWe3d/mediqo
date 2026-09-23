"""Location service (Step 6).

Reusable geographic utilities for Mediqo:

- `validate_coordinates` — bounds check for browser-provided coordinates.
- `resolve_city` — manual city fallback; a city is supported only if it
  actually exists in the doctor database AND we know its approximate
  center (no external geocoder in the MVP).
- `calculate_distance` — Haversine great-circle distance in kilometers.

Privacy rules:
- Coordinates are request/session data only. Nothing here writes to the
  database, and callers must not log precise coordinates.

NOTE: the doctor *matching engine* (Step 7) is intentionally NOT part of
this module — only reusable location primitives live here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Doctor

# Mean Earth radius (km) — accurate to ~0.1% for MVP distance scoring.
EARTH_RADIUS_KM = 6371.0

# Approximate city-center coordinates for the cities present in the seeded
# doctor database. Manual fallback resolves to these centers; there is no
# external geocoding provider in the MVP (by design). Keep this the single
# source of truth for city centers — the demo seed uses the same values.
CITY_CENTERS: dict[str, tuple[float, float]] = {
    "lucknow": (26.8467, 80.9462),
    "kanpur": (26.4499, 80.3329),
    "unnao": (26.5480, 80.3650),
    "sitapur": (27.1750, 80.6820),
    "gorakhpur": (26.7606, 83.3732),
    "delhi": (28.6139, 77.2090),
    "jaipur": (26.9124, 75.7873),
    "kolkata": (22.5726, 88.3639),
    "mumbai": (19.0760, 72.8777),
    "pune": (18.5204, 73.8567),
    "bengaluru": (12.9716, 77.5946),
    "hyderabad": (17.3850, 78.4867),
    "chennai": (13.0827, 80.2707),
    "kochi": (9.9312, 76.2673),
    "thiruvananthapuram": (8.5241, 76.9366),
    "kozhikode": (11.2588, 75.7804),
}


@dataclass(frozen=True)
class CityResolution:
    """A successfully resolved manual city."""

    city: str  # canonical display name, e.g. "Lucknow"
    latitude: float
    longitude: float


def validate_coordinates(latitude: float, longitude: float) -> bool:
    """True if the coordinate pair is within valid geographic bounds.

    Note: NaN/inf fail these comparisons and are treated as invalid.
    """
    try:
        return -90 <= latitude <= 90 and -180 <= longitude <= 180
    except (TypeError, ValueError):
        return False


def calculate_distance(
    user_latitude: float,
    user_longitude: float,
    doctor_latitude: float,
    doctor_longitude: float,
) -> float:
    """Great-circle distance between two points, in kilometers (Haversine).

    Straight-line distance only — good enough for MVP proximity scoring;
    road distance via a maps provider can be added later.
    """
    phi1 = math.radians(user_latitude)
    phi2 = math.radians(doctor_latitude)
    delta_phi = math.radians(doctor_latitude - user_latitude)
    delta_lambda = math.radians(doctor_longitude - user_longitude)

    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def resolve_city(city: str, db: Session) -> CityResolution | None:
    """Resolve a manually entered city against the doctor database.

    Case-insensitive and whitespace-tolerant. Returns None when the city is
    unknown, has no doctors, or has no known center coordinates.
    """
    normalized = city.strip().lower()
    if not normalized or normalized not in CITY_CENTERS:
        return None

    doctor_count = db.scalar(
        select(func.count()).select_from(Doctor).where(func.lower(Doctor.city) == normalized)
    )
    if not doctor_count:
        return None

    latitude, longitude = CITY_CENTERS[normalized]
    return CityResolution(city=normalized.title(), latitude=latitude, longitude=longitude)


def get_supported_cities(db: Session) -> list[tuple[str, int]]:
    """Cities present in the doctor database with their doctor counts,
    largest first (useful for the frontend's manual-fallback dropdown)."""
    rows = db.execute(
        select(Doctor.city, func.count())
        .group_by(Doctor.city)
        .order_by(func.count().desc(), Doctor.city)
    ).all()
    return [(city, int(count)) for city, count in rows]
