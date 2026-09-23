"""Pydantic response contracts for the Doctor API.

These schemas are the API's public face: SQLAlchemy objects are never
returned directly. `is_demo` is deliberately exposed so clients can label
demo/sample data honestly (e.g. "Demo profile", "Sample review").
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DoctorListItem(BaseModel):
    """A doctor as it appears in list results."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    specialization: str
    qualification: str
    experience_years: int
    languages: list[str]
    consultation_fee: float = Field(description="Consultation fee in INR")
    clinic_name: str
    address: str
    city: str
    latitude: float
    longitude: float
    availability: dict
    bio: str | None
    profile_image: str | None
    rating: float = Field(description="Average rating 0-5 (from demo reviews)")
    review_count: int
    verified: bool = Field(description="Mediqo credential verification (future flow)")
    is_demo: bool = Field(description="True for seeded fictional demo profiles")


class DoctorDetail(DoctorListItem):
    """Complete doctor profile (adds timestamps + a readable schedule)."""

    availability_summary: str = Field(
        description="Human-readable schedule, e.g. 'Mon–Sat 4 PM–8 PM'"
    )
    created_at: datetime
    updated_at: datetime


class DoctorListResponse(BaseModel):
    """Paginated doctor list envelope."""

    items: list[DoctorListItem]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=50)
    total: int = Field(ge=0, description="Total doctors matching the filters")
    pages: int = Field(ge=0, description="Total pages for this page_size")


class ReviewOut(BaseModel):
    """A single review. Demo reviews carry is_demo=true."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    reviewer_name: str
    rating: int = Field(ge=1, le=5)
    comment: str | None
    created_at: datetime
    verified_visit: bool
    is_demo: bool


class DoctorReviewsResponse(BaseModel):
    """Paginated reviews for one doctor."""

    doctor_id: int
    reviews: list[ReviewOut]
    total: int = Field(ge=0, description="Total reviews for this doctor")
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=50)
