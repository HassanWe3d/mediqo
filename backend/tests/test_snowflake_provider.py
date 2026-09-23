"""Mediqo — Snowflake Cortex AI provider verification.

Run from the backend/ directory:

    .venv/Scripts/python.exe tests/test_snowflake_provider.py

Covers the AI_PROVIDER=snowflake integration: Cortex Chat Completions
request shape, response parsing into the exact /analyze-problem contract,
normalization of invalid model output, API errors, timeouts, secret
handling, and keyword-provider regression.

NO live Snowflake calls: httpx.post is mocked and settings attributes are
patched per-test. No PAT, account URL or model is hardcoded in the app —
only in this test's fakes.
"""

import sys
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.schemas.matching import MedicalProblemAnalysis
from app.services.ai_service import (
    AIProviderError,
    KeywordProvider,
    MediqoAIService,
    SnowflakeCortexProvider,
    get_ai_service,
)

client = TestClient(app)

TEST_PAT = "test-pat-NOT-A-REAL-SECRET"
TEST_BASE = "https://fake-account.snowflakecomputing.com/api/v2/cortex/v1"
TEST_MODEL = "test-model-name"

RESULTS: list[tuple[str, bool, str]] = []


def expect(condition: bool, name: str, detail: str = "") -> None:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    suffix = f" — {detail}" if (detail and not condition) else ""
    print(f"[{status}] {name}{suffix}")


class FakeResponse:
    """Minimal httpx.Response stand-in."""

    def __init__(self, status_code: int = 200, content: str = "{}"):
        self.status_code = status_code
        self._content = content

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"error {self.status_code}", request=mock.Mock(), response=mock.Mock()
            )

    def json(self) -> dict:
        import json

        return json.loads(self._content)


def cortex_body(content: str) -> str:
    """Snowflake/OpenAI-compatible chat-completions response body."""
    import json

    return json.dumps(
        {"choices": [{"message": {"role": "assistant", "content": content}}]}
    )


def make_provider() -> SnowflakeCortexProvider:
    return SnowflakeCortexProvider()


def patched_env():
    """Patch the Settings singleton's AI fields for the duration of a test."""
    return mock.patch.multiple(
        settings,
        ai_provider="snowflake",
        ai_api_key=TEST_PAT,
        ai_model=TEST_MODEL,
        ai_base_url=TEST_BASE,
        ai_timeout_seconds=10.0,
    )


VALID_CONTENT = (
    '```json\n{"specialization": "dentist", "urgency": "normal",'
    ' "summary": "The user is describing tooth pain and may need dental'
    ' evaluation.", "possible_keywords": ["tooth pain"]}\n```'
)


def main() -> int:
    print("Mediqo — Snowflake Cortex provider verification")
    print("=" * 60)

    # --- 1. Success: request shape, auth, parsing, exact public contract ---
    with patched_env():
        provider = make_provider()
        with mock.patch("app.services.ai_service.httpx.post") as post:
            post.return_value = FakeResponse(200, cortex_body(VALID_CONTENT))
            analysis = provider.analyze_medical_problem("I have severe tooth pain.")

        expect(analysis.specialization == "Dentist" and analysis.urgency == "normal",
               "Cortex success parses into the Mediqo analysis",
               f"got {analysis.specialization}/{analysis.urgency}")
        MedicalProblemAnalysis.model_validate(analysis)
        expect(True, "Parsed analysis validates against MedicalProblemAnalysis")

        request = post.call_args
        expect(request.args and request.args[0] == f"{TEST_BASE}/chat/completions",
               "POSTs to {AI_BASE_URL}/chat/completions",
               f"got {request.args}")
        payload = request.kwargs["json"]
        expect(payload["model"] == TEST_MODEL,
               "Request body uses AI_MODEL from the environment")
        expect(set(payload) == {"model", "messages"},
               "Request body is exactly {model, messages}",
               f"got keys {sorted(payload)}")
        expect(payload["messages"][0]["role"] == "system"
               and payload["messages"][1] == {"role": "user",
                                              "content": "I have severe tooth pain."},
               "Messages follow the shared medical-navigation prompt")
        expect(request.kwargs["headers"]["Authorization"] == f"Bearer {TEST_PAT}",
               "Authorization: Bearer <PAT> header is sent")

    # --- 2. Configuration comes from env; nothing hardcoded ---
    expect(TEST_MODEL not in Path("app/services/ai_service.py").read_text(encoding="utf-8")
           and TEST_BASE not in Path("app/services/ai_service.py").read_text(encoding="utf-8")
           and TEST_PAT not in Path("app/services/ai_service.py").read_text(encoding="utf-8"),
           "No PAT / account URL / model hardcoded in the provider")

    # --- 3. Missing key -> controlled error, facade degrades to keyword ---
    with mock.patch.multiple(settings, ai_provider="snowflake", ai_api_key=""):
        try:
            make_provider()
            expect(False, "Missing AI_API_KEY raises AIProviderError")
        except AIProviderError:
            expect(True, "Missing AI_API_KEY raises AIProviderError")
        service = get_ai_service()
        expect(service.provider_name == "keyword"
               and service.analyze_medical_problem("I have tooth pain.").specialization == "Dentist",
               "AI_PROVIDER=snowflake without a key degrades to keyword provider",
               f"got {service.provider_name}")

    # --- 4. Malformed / invalid model output ---
    with patched_env():
        provider = make_provider()
        for label, content in [
            ("prose, no JSON", "I am sorry, I cannot help with that."),
            ("invalid JSON", '{"specialization": "Dentist", '),
            ("invented specialty", '{"specialization": "Wizard", "urgency": "normal", "summary": "x"}'),
            ("missing specialization", '{"urgency": "normal", "summary": "x"}'),
        ]:
            with mock.patch("app.services.ai_service.httpx.post") as post:
                post.return_value = FakeResponse(200, cortex_body(content))
                try:
                    provider.analyze_medical_problem("I have severe tooth pain.")
                    expect(False, f"Malformed output rejected: {label}")
                except AIProviderError:
                    expect(True, f"Malformed output rejected: {label}")

        # Invalid urgency degrades safely instead of failing the request
        with mock.patch("app.services.ai_service.httpx.post") as post:
            post.return_value = FakeResponse(200, cortex_body(
                '{"specialization": "Dentist", "urgency": "kind of urgent", "summary": "x"}'))
            analysis = provider.analyze_medical_problem("I have severe tooth pain.")
        expect(analysis.urgency == "normal" and analysis.specialization == "Dentist",
               "Invalid urgency normalized to normal (specialty preserved)",
               f"got {analysis.urgency}")

    # --- 5. Cortex API error (401) -> controlled, secret-free failure ---
    with patched_env():
        provider = make_provider()
        with mock.patch("app.services.ai_service.httpx.post") as post:
            post.return_value = FakeResponse(401, '{"message": "invalid token"}')
            try:
                provider.analyze_medical_problem("I have severe tooth pain.")
                expect(False, "API error status raises AIProviderError")
            except AIProviderError as exc:
                expect(True, "API error status raises AIProviderError")
                expect(TEST_PAT not in str(exc) and "invalid token" not in str(exc),
                       "Provider error message exposes no PAT / upstream body")

        # ...and through the facade: safe fallback, honest source marker
        service = MediqoAIService(provider)
        with mock.patch("app.services.ai_service.httpx.post") as post:
            post.return_value = FakeResponse(401, '{"message": "invalid token"}')
            result = service.analyze_medical_problem("I have stomach pain.")
        expect(result.specialization == "General Physician" and result.urgency == "normal"
               and result.source == "fallback",
               "Cortex failure -> safe fallback via the existing facade",
               f"got {result.specialization}/{result.urgency}/{result.source}")

    # --- 6. Timeout -> controlled failure, no crash ---
    with patched_env():
        provider = make_provider()
        with mock.patch("app.services.ai_service.httpx.post",
                        side_effect=httpx.ReadTimeout("timed out")):
            try:
                provider.analyze_medical_problem("I have severe tooth pain.")
                expect(False, "Timeout raises AIProviderError")
            except AIProviderError:
                expect(True, "Timeout raises AIProviderError")

    # --- 7. Emergency safety net outranks the provider (no API call) ---
    with patched_env():
        provider = make_provider()
        service = MediqoAIService(provider)
        with mock.patch("app.services.ai_service.httpx.post") as post:
            result = service.analyze_medical_problem("I have crushing chest pain.")
        expect(result.urgency == "emergency" and result.source == "emergency"
               and "emergency" in result.summary.lower(),
               "Emergency pre-check bypasses Snowflake entirely")
        expect(not post.called, "No Cortex request is made for emergencies")

        # Provider-classified emergency is also normalized to the fixed response
        with mock.patch("app.services.ai_service.httpx.post") as post:
            post.return_value = FakeResponse(200, cortex_body(
                '{"specialization": "Cardiologist", "urgency": "emergency",'
                ' "summary": "possible heart issue", "possible_keywords": []}'))
            result = service.analyze_medical_problem("my father collapsed")
        expect(result.urgency == "emergency" and result.source == "emergency"
               and result.specialization == "General Physician",
               "Provider emergency output adopts the fixed emergency response")

    # --- 8. API contract unchanged: /analyze-problem with the Cortex provider ---
    with patched_env():
        provider = make_provider()
        app.dependency_overrides[get_ai_service] = lambda: MediqoAIService(provider)
        try:
            with mock.patch("app.services.ai_service.httpx.post") as post:
                post.return_value = FakeResponse(200, cortex_body(VALID_CONTENT))
                response = client.post(
                    "/analyze-problem", json={"problem": "I have severe tooth pain."}
                )
            expect(response.status_code == 200, "/analyze-problem returns 200 via Cortex",
                   f"got {response.status_code}: {response.text[:120]}")
            body = response.json()
            expect(set(body) == {"specialization", "urgency", "summary",
                                 "possible_keywords"},
                   "Public /analyze-problem schema is exactly unchanged",
                   f"keys: {sorted(body)}")
            expect(body["specialization"] == "Dentist",
                   "Cortex-analyzed specialty reaches the API response",
                   f"got {body.get('specialization')}")

            # Network failure at the API layer -> 200 + fallback content
            with mock.patch("app.services.ai_service.httpx.post",
                            side_effect=httpx.ConnectError("refused")):
                data = client.post("/analyze-problem",
                                   json={"problem": "My skin has a rash."}).json()
            expect(data["specialization"] == "General Physician"
                   and data["urgency"] == "normal",
                   "Cortex outage -> controlled fallback response, no 500")
        finally:
            app.dependency_overrides.pop(get_ai_service, None)

    # --- 9. Keyword provider regression (unchanged behavior) ---
    keyword = MediqoAIService(KeywordProvider())
    for problem, expected in [
        ("I have severe tooth pain.", "Dentist"),
        ("My skin has developed a rash.", "Dermatologist"),
        ("I have blurry vision.", "Ophthalmologist"),
        ("My child has fever.", "Pediatrician"),
        ("I have stomach pain and digestive problems.", "Gastroenterologist"),
    ]:
        analysis = keyword.analyze_medical_problem(problem)
        expect(analysis.specialization == expected,
               f"Keyword regression: '{problem[:36]}' -> {expected}",
               f"got {analysis.specialization}")

    with mock.patch.multiple(settings, ai_provider="snowflake", ai_api_key=""):
        service = get_ai_service()
        expect(service.provider_name == "keyword",
               "get_ai_service still resolves keyword when Snowflake is unconfigured")

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("=" * 60)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        return 1
    print("All Snowflake provider checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
