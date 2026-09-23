"""Doctor ORM model — the core entity of the Mediqo MVP.

Design notes:
- `is_demo=True` marks seeded fictional demo profiles (MVP). Real doctors
  added later will have `is_demo=False` and, post-MVP, a link to doctor
  account / credential tables (not implemented in the MVP).
- `languages` uses a PostgreSQL ARRAY for MVP simplicity; normalization into
  `languages` / `doctor_languages` tables is planned for post-MVP.
- `availability` is a structured JSONB weekly schedule so the matching engine
  can score "available today" without parsing free text. Shape:

      {"mon": [["16:00", "20:00"]],
       "sat": [["10:00", "13:00"], ["16:00", "20:00"]]}

  Days are keys "mon".."sun"; each day maps to a list of [start, end] 24h
  time intervals. `{}` means no schedule data.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    Integer,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

_DAY_ORDER = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_LABELS = {
    "mon": "Mon",
    "tue": "Tue",
    "wed": "Wed",
    "thu": "Thu",
    "fri": "Fri",
    "sat": "Sat",
    "sun": "Sun",
}


def _format_time(value: str) -> str:
    """Render a 24h time ('16:00') as a compact 12h label ('4 PM')."""
    try:
        hour, minute = (int(part) for part in str(value).split(":"))
    except ValueError:
        return str(value)
    suffix = "AM" if hour < 12 else "PM"
    display_hour = hour % 12 or 12
    if minute:
        return f"{display_hour}:{minute:02d} {suffix}"
    return f"{display_hour} {suffix}"


def _collapse_day_runs(day_keys: list[str]) -> str:
    """Collapse weekly-ordered day keys into ranges: ['mon','tue','wed','fri'] -> 'Mon–Wed, Fri'."""
    ordered = [day for day in _DAY_ORDER if day in day_keys]
    if not ordered:
        return ""
    runs: list[str] = []
    start = prev = ordered[0]
    for day in ordered[1:]:
        if _DAY_ORDER.index(day) == _DAY_ORDER.index(prev) + 1:
            prev = day
            continue
        runs.append(_DAY_LABELS[start] if start == prev else f"{_DAY_LABELS[start]}–{_DAY_LABELS[prev]}")
        start = prev = day
    runs.append(_DAY_LABELS[start] if start == prev else f"{_DAY_LABELS[start]}–{_DAY_LABELS[prev]}")
    return ", ".join(runs)


class Doctor(Base):
    """A doctor discoverable through Mediqo.

    All seeded MVP rows must keep `is_demo=True`. `verified` refers to Mediqo
    credential verification (future doctor-account flow), not demo status.
    """

    __tablename__ = "doctors"
    __table_args__ = (
        CheckConstraint("rating >= 0 AND rating <= 5", name="ck_doctors_rating_range"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    specialization: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    qualification: Mapped[str] = mapped_column(String(200), nullable=False)
    experience_years: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    languages: Mapped[list[str]] = mapped_column(
        ARRAY(String(50)), nullable=False, default=list, server_default=text("'{}'")
    )
    consultation_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    clinic_name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str] = mapped_column(String(300), nullable=False)
    city: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # Double precision keeps ample coordinate precision and feeds the
    # haversine distance calculation in the matching engine directly as float.
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    availability: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_image: Mapped[str | None] = mapped_column(String(500), nullable=True)
    rating: Mapped[Decimal] = mapped_column(
        Numeric(2, 1), nullable=False, default=Decimal("0.0"), server_default=text("0")
    )
    review_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    is_demo: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    # Doctor 1 --- * Review
    reviews: Mapped[list["Review"]] = relationship(
        back_populates="doctor",
        cascade="all, delete-orphan",
        order_by="Review.created_at.desc()",
        passive_deletes=True,  # relies on the DB-level ON DELETE CASCADE
    )

    @property
    def availability_summary(self) -> str:
        """Compact human-readable schedule, e.g. 'Mon–Sat 4 PM–8 PM'."""
        if not self.availability:
            return "Not specified"
        by_interval: dict[str, list[str]] = {}
        for day in _DAY_ORDER:
            for interval in self.availability.get(day) or []:
                if not (isinstance(interval, (list, tuple)) and len(interval) == 2):
                    continue
                label = f"{_format_time(interval[0])}–{_format_time(interval[1])}"
                by_interval.setdefault(label, []).append(day)
        summary = "; ".join(
            f"{_collapse_day_runs(days)} {label}" for label, days in by_interval.items()
        )
        return summary or "Not specified"

    def __repr__(self) -> str:
        return f"<Doctor id={self.id} name={self.name!r} specialization={self.specialization!r}>"
