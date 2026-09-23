"""Pydantic schema package (API request/response contracts).

Contracts live in submodules (e.g. `app.schemas.doctor`); routes import them
directly. SQLAlchemy objects are never returned from routes — always through
these schemas.
"""
