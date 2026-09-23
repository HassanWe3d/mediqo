# Mediqo Backend

FastAPI + SQLAlchemy + PostgreSQL backend for the **Mediqo** MVP — a medical
doctor-discovery service that matches a user's location and plain-language
problem description to suitable nearby doctors.

> ⚠️ **MVP status** — demo data only. All doctors and reviews seeded for the
> demo are fictional (`is_demo = true`). Mediqo is **not** a diagnostic system.

## Tech stack

| Layer     | Choice                            |
|-----------|-----------------------------------|
| Framework | FastAPI (Python 3.12+)            |
| ORM       | SQLAlchemy 2.x                    |
| Database  | PostgreSQL                        |
| Config    | pydantic-settings (`.env`)        |

## Setup

```bash
cd backend

# 1. Create & activate a virtual environment
python -m venv .venv
source .venv/Scripts/activate      # Windows (Git Bash)
# source .venv/bin/activate        # Linux / macOS

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env               # then edit if needed

# 4. Start PostgreSQL (local dev via Docker)
docker run -d --name mediqo-postgres \
  -e POSTGRES_USER=mediqo -e POSTGRES_PASSWORD=mediqo_dev \
  -e POSTGRES_DB=mediqo -p 5432:5432 postgres:16-alpine

# 5. Run the API
uvicorn app.main:app --reload --port 8000
```

## Endpoints (current)

| Method | Path                        | Description                                |
|--------|-----------------------------|--------------------------------------------|
| GET    | `/health`                   | Liveness probe (no DB access)              |
| GET    | `/health/db`                | API + PostgreSQL connectivity              |
| GET    | `/doctors`                  | Paginated doctor list, filters (Step 4)    |
| GET    | `/doctors/{id}`             | Full doctor profile (Step 4)               |
| GET    | `/doctors/{id}/reviews`     | Paginated reviews for a doctor (Step 4)    |
| POST   | `/analyze-problem`          | Non-diagnostic problem analysis (Step 5)   |
| POST   | `/location/validate`        | Validate browser coordinates (Step 6)      |
| POST   | `/location/manual`          | Manual city fallback (Step 6)              |
| GET    | `/location/cities`          | Supported cities for manual fallback       |
| POST   | `/match-doctors`            | Core matching engine (Step 7)              |

Interactive docs: <http://localhost:8000/docs>

## AI providers (`/analyze-problem`)

The AI service is provider-agnostic (`AI_PROVIDER` in `.env`). All providers
share the same safety net (deterministic emergency detection, no diagnosis),
the same validation/normalization, and the exact same response schema.

| `AI_PROVIDER` | Behavior |
|---------------|----------|
| `keyword` *(default)* | Offline deterministic rule-based analyzer. No key, no network. |
| `openai` | Any OpenAI-compatible Chat Completions API. |
| `snowflake` | Snowflake Cortex REST API via its OpenAI-compatible Chat Completions endpoint. |

Snowflake Cortex configuration (all from environment — never hardcoded):

```env
AI_PROVIDER=snowflake
AI_API_KEY=<Snowflake PAT>
AI_MODEL=openai-gpt-5-mini
AI_BASE_URL=https://<account>.snowflakecomputing.com/api/v2/cortex/v1
AI_TIMEOUT_SECONDS=10
```

The provider POSTs `{AI_BASE_URL}/chat/completions` with
`Authorization: Bearer <PAT>` and body `{"model": ..., "messages": [...]}`.
If Cortex is unavailable, returns an error, or emits malformed output, the
service degrades to the safe fallback (General Physician / normal) exactly
like the other providers — the API never exposes the PAT or upstream errors.

## Project layout

```
backend/app/
├── main.py        # FastAPI app factory
├── config.py      # Settings from .env
├── database.py    # Engine, sessions, Base
├── routes/        # HTTP endpoints (health, doctors, reviews, matching)
├── models/        # SQLAlchemy ORM models (Doctor, Review)
├── schemas/       # Pydantic contracts (Step 4+)
└── services/      # AI + matching logic (Step 5+)
```

## Frontend location contract (Step 6)

The **browser** owns permission handling; the backend only validates what it
receives. The React frontend should implement:

```js
navigator.geolocation.getCurrentPosition(
  (position) => {
    // POST /location/validate  {"latitude": position.coords.latitude,
    //                            "longitude": position.coords.longitude}
  },
  (error) => {
    // error.code 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
    // fallback: POST /location/manual {"city": "<user input>"}
  },
  { enableHighAccuracy: true, timeout: 10000 }
);
```

UI states to cover:

| State              | Message                                                |
|--------------------|--------------------------------------------------------|
| Initial            | "Allow Mediqo to access your location."                |
| Requesting         | "Getting your location..."                             |
| Success            | "Location detected."                                   |
| Permission denied  | "Location access was denied."                          |
| Position unavailable | "We couldn't determine your location."               |
| Browser unsupported | "Location services are not available in this browser."|
| Manual fallback    | "Enter your city manually." (`GET /location/cities`)   |

Privacy: the backend treats coordinates as request/session data only —
nothing is persisted and precise coordinates are never logged.

## Roadmap (MVP steps)

1. ✅ Backend foundation + `/health`
2. ✅ Doctor & Review models (SQLAlchemy)
3. Demo seed data (`seed.py`, `is_demo = true`)
4. Doctor API (`/doctors`, `/doctors/{id}`, `/doctors/{id}/reviews`)
5. AI service (specialty + urgency, provider-agnostic, non-diagnostic)
6. Location handling (browser geolocation + manual city fallback)
7. Matching engine (`POST /match-doctor`) with explainable scoring
8. Frontend integration
