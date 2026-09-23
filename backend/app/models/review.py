"""Review ORM model — patient feedback attached to a Doctor.

MVP policy: every seeded review keeps `is_demo=True` so demo content can
always be distinguished from genuine patient reviews (which a future,
authenticated review flow would create with `is_demo=False`).
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Review(Base):
    """A review attached to exactly one Doctor (many per doctor)."""

    __tablename__ = "reviews"
    __table_args__ = (
        CheckConstraint("rating >= 1 AND rating <= 5", name="ck_reviews_rating_range"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doctor_id: Mapped[int] = mapped_column(
        ForeignKey("doctors.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reviewer_name: Mapped[str] = mapped_column(String(120), nullable=False)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    verified_visit: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    is_demo: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    doctor: Mapped["Doctor"] = relationship(back_populates="reviews")

    def __repr__(self) -> str:
        return (
            f"<Review id={self.id} doctor_id={self.doctor_id} "
            f"rating={self.rating} is_demo={self.is_demo}>"
        )
