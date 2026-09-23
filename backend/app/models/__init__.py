"""SQLAlchemy ORM models package.

Importing this package registers every model on `Base.metadata`, so
`Base.metadata.create_all()` (see `app.database.init_db`) discovers them all.
Always add new models here.
"""

from app.models.doctor import Doctor
from app.models.review import Review

__all__ = ["Doctor", "Review"]
