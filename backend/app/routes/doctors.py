"""Doctor API routes.

All data comes from PostgreSQL via SQLAlchemy — nothing is hardcoded.
Filtering, counting and pagination happen at the database level.
"""

from math import ceil

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Doctor, Review
from app.schemas.doctor import (
    DoctorDetail,
    DoctorListResponse,
    DoctorListItem,
    DoctorReviewsResponse,
)

router = APIRouter(prefix="/doctors", tags=["Doctors"])

MAX_PAGE_SIZE = 50


@router.get(
    "",
    response_model=DoctorListResponse,
    summary="List doctors (paginated, filterable)",
    description=(
        "Returns a paginated list of doctors from PostgreSQL. "
        "Optional case-insensitive filters: `specialization`, `city` "
        "(combinable). MVP data is fictional demo data (`is_demo: true`)."
    ),
)
def list_doctors(
    page: int = Query(1, ge=1, description="1-based page number"),
    page_size: int = Query(10, ge=1, le=MAX_PAGE_SIZE, description=f"Items per page (1-{MAX_PAGE_SIZE})"),
    specialization: str | None = Query(
        None, min_length=1, max_length=100, description="Case-insensitive exact match, e.g. 'Dentist'"
    ),
    city: str | None = Query(
        None, min_length=1, max_length=100, description="Case-insensitive exact match, e.g. 'Lucknow'"
    ),
    db: Session = Depends(get_db),
) -> DoctorListResponse:
    query = select(Doctor)
    if specialization is not None:
        query = query.where(func.lower(Doctor.specialization) == specialization.strip().lower())
    if city is not None:
        query = query.where(func.lower(Doctor.city) == city.strip().lower())

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    items = db.scalars(
        query.order_by(Doctor.id).offset((page - 1) * page_size).limit(page_size)
    ).all()

    return DoctorListResponse(
        items=[DoctorListItem.model_validate(doctor) for doctor in items],
        page=page,
        page_size=page_size,
        total=total,
        pages=ceil(total / page_size) if total else 0,
    )


@router.get(
    "/{doctor_id}",
    response_model=DoctorDetail,
    summary="Get one doctor's full profile",
    responses={404: {"description": "Doctor not found"}},
)
def get_doctor(
    doctor_id: int = Path(gt=0, description="Doctor id"),
    db: Session = Depends(get_db),
) -> DoctorDetail:
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Doctor not found",
        )
    return DoctorDetail.model_validate(doctor)


@router.get(
    "/{doctor_id}/reviews",
    response_model=DoctorReviewsResponse,
    summary="List reviews for one doctor (paginated)",
    description=(
        "Returns only the reviews belonging to the requested doctor, "
        "newest first. Demo reviews carry `is_demo: true` and must be "
        "labelled as sample content by clients."
    ),
    responses={404: {"description": "Doctor not found"}},
)
def list_doctor_reviews(
    doctor_id: int = Path(gt=0, description="Doctor id"),
    page: int = Query(1, ge=1, description="1-based page number"),
    page_size: int = Query(10, ge=1, le=MAX_PAGE_SIZE, description=f"Items per page (1-{MAX_PAGE_SIZE})"),
    db: Session = Depends(get_db),
) -> DoctorReviewsResponse:
    if db.get(Doctor, doctor_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Doctor not found",
        )

    total = db.scalar(
        select(func.count()).select_from(Review).where(Review.doctor_id == doctor_id)
    ) or 0
    reviews = db.scalars(
        select(Review)
        .where(Review.doctor_id == doctor_id)
        .order_by(Review.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    return DoctorReviewsResponse(
        doctor_id=doctor_id,
        reviews=list(reviews),
        total=total,
        page=page,
        page_size=page_size,
    )
