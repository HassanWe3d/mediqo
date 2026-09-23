"""Application configuration loaded from environment variables / .env file.

All runtime configuration flows through this module so no other component
reads the environment directly. Secrets (e.g. AI API keys) must only ever be
provided via .env and must never be committed.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ directory (config.py lives in backend/app/)
BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- App ----
    app_name: str = "Mediqo"
    debug: bool = True

    # ---- Database (PostgreSQL) ----
    # Plain libpq-style URL. The psycopg (v3) SQLAlchemy dialect is applied
    # in `sqlalchemy_database_url` below.
    database_url: str = "postgresql://mediqo:mediqo_dev@localhost:5432/mediqo"

    # Seconds before giving up on a PostgreSQL connect attempt. Without this,
    # an unreachable database (e.g. Docker container stopped) can hang TCP
    # connects for 20s+ per resolved address instead of failing fast.
    db_connect_timeout: int = 3

    # ---- CORS ----
    # Comma-separated list of allowed frontend origins.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # ---- AI provider (used from Step 5 onwards) ----
    # "keyword"   = offline deterministic rule-based analyzer (no key needed)
    # "openai"    = any OpenAI-compatible chat-completions API (set AI_API_KEY)
    # "snowflake" = Snowflake Cortex REST API, OpenAI-compatible Chat
    #               Completions (AI_BASE_URL = https://<account>.snowflakecomputing.com/api/v2/cortex/v1)
    ai_provider: str = "keyword"
    ai_api_key: str = ""
    ai_model: str = "gpt-4o-mini"
    ai_base_url: str = "https://api.openai.com/v1"
    ai_timeout_seconds: float = 10.0

    @property
    def sqlalchemy_database_url(self) -> str:
        """Normalize the database URL for the psycopg (v3) SQLAlchemy driver."""
        url = self.database_url.strip()
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS origins as a list, stripped and empty-filtered."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (single Settings instance per process)."""
    return Settings()


settings = get_settings()


# ---- Matching engine weights (Step 7) ----
# Single source of truth for the suitability score. Must sum to 1.0.
# Adjust here to retune the engine — never scatter magic numbers in code.
MATCH_WEIGHTS: dict[str, float] = {
    "specialization": 0.40,
    "distance": 0.25,
    "availability": 0.15,
    "language": 0.10,
    "rating": 0.10,
}
