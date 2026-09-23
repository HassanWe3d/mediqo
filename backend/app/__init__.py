"""
Mediqo backend application package.

Mediqo helps users find a suitable doctor based on their current location
and a plain-language description of their medical problem — without needing
to know which medical specialization they require.

Layering rules (keep them intact):
    routes/    -> HTTP endpoints only (no business logic)
    services/  -> AI + matching logic
    models/    -> SQLAlchemy ORM models
    schemas/   -> Pydantic request/response contracts
    database.py-> PostgreSQL connection & session management
"""
