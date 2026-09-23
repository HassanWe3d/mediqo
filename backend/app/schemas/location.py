"""Location contracts (Step 6).

Privacy: coordinates are request/session data only — they are validated and
used for matching, never persisted and never logged by the backend.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class LocationInput(BaseModel):
    """Coordinates from the browser Geolocation API (POST /location/validate)."""

    latitude: float = Field(ge=-90, le=90, description="Latitude in decimal degrees (-90..90)")
    longitude: float = Field(ge=-180, le=180, description="Longitude in decimal degrees (-180..180)")


class ManualLocationInput(BaseModel):
    """Manual city fallback when geolocation is denied (POST /location/manual)."""

    city: str = Field(min_length=2, max_length=100, description="City name, e.g. 'Lucknow'")

    @field_validator("city")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("City must not be empty or whitespace-only")
        return value.strip()


class LocationValidationResponse(BaseModel):
    valid: Literal[True]
    latitude: float
    longitude: float


class ManualLocationResponse(BaseModel):
    """Resolution of a manual city. Includes city-center coordinates so the
    matching engine (Step 7) can compute distances without a geocoder."""

    valid: Literal[True]
    city: str = Field(description="Canonical city name as stored in the doctor database")
    latitude: float | None = Field(default=None, description="Approximate city-center latitude")
    longitude: float | None = Field(default=None, description="Approximate city-center longitude")


class SupportedCity(BaseModel):
    """A city available for manual fallback (GET /location/cities)."""

    city: str
    doctor_count: int = Field(ge=0)
    latitude: float | None = None
    longitude: float | None = None
