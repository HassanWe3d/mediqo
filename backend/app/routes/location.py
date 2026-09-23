"""Location API routes (Step 6).

The browser owns permission handling (`navigator.geolocation`); this API only
validates what the frontend sends and resolves the manual city fallback.

Privacy: precise coordinates are never logged and never persisted — they are
treated as request/session data for the future matching engine.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.location import (
    LocationInput,
    LocationValidationResponse,
    ManualLocationInput,
    ManualLocationResponse,
    SupportedCity,
)
from app.services.location_service import CITY_CENTERS, get_supported_cities, resolve_city

router = APIRouter(prefix="/location", tags=["Location"])


@router.post(
    "/validate",
    response_model=LocationValidationResponse,
    summary="Validate coordinates from the browser Geolocation API",
    description=(
        "Validates latitude/longitude bounds. Out-of-range or non-numeric "
        "values return a clean 422. Coordinates are session data: they are "
        "not stored or logged."
    ),
    responses={422: {"description": "Coordinates out of range or malformed"}},
)
def validate_location(payload: LocationInput) -> LocationValidationResponse:
    return LocationValidationResponse(
        valid=True, latitude=payload.latitude, longitude=payload.longitude
    )


@router.post(
    "/manual",
    response_model=ManualLocationResponse,
    summary="Manual city fallback (when geolocation is denied)",
    description=(
        "Resolves a city name against the cities actually present in the "
        "doctor database (case-insensitive). Returns city-center coordinates "
        "for the matching engine. No external geocoding is used in the MVP."
    ),
    responses={400: {"description": "City not supported (unknown or no doctors)"}},
)
def manual_location(
    payload: ManualLocationInput,
    db: Session = Depends(get_db),
) -> ManualLocationResponse:
    resolution = resolve_city(payload.city, db)
    if resolution is None:
        raise HTTPException(
            status_code=400,
            detail="This location is not currently supported.",
        )
    return ManualLocationResponse(
        valid=True,
        city=resolution.city,
        latitude=resolution.latitude,
        longitude=resolution.longitude,
    )


@router.get(
    "/cities",
    response_model=list[SupportedCity],
    summary="Cities available for the manual fallback",
    description="Cities that actually have doctors in the database, largest first.",
)
def list_supported_cities(db: Session = Depends(get_db)) -> list[SupportedCity]:
    cities: list[SupportedCity] = []
    for city, count in get_supported_cities(db):
        center = CITY_CENTERS.get(city.lower())
        cities.append(
            SupportedCity(
                city=city,
                doctor_count=count,
                latitude=center[0] if center else None,
                longitude=center[1] if center else None,
            )
        )
    return cities
