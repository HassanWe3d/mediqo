"""AI medical-problem understanding service (Step 5).

Purpose
-------
Turn a user's plain-language problem description into structured data the
matching engine (Step 7) can use: likely relevant specialty + urgency.

MEDICAL SAFETY BOUNDARY
-----------------------
Mediqo is a doctor-DISCOVERY application, not a diagnostic system. The AI
must never name diseases or conditions ("you have appendicitis" is wrong);
it only suggests which kind of medical professional may be relevant.

Provider-agnostic design
------------------------
`AIService` (Protocol) is the interface the rest of the backend depends on:

- `KeywordProvider`  — offline, deterministic rule-based analyzer. No API
  key, no network, stable results. Ideal for the MVP demo and for tests.
- `OpenAIProvider`   — any OpenAI-compatible chat-completions API
  (OpenAI, Azure OpenAI, local gateways...) configured via env vars.
  Never hardcode keys; the key is read from Settings only.

`get_ai_service()` picks the provider from settings. If the configured
provider is unavailable or returns malformed output, the service degrades
to a safe fallback (General Physician / normal) and marks the result
internally with `source="fallback"` — the API layer strips that marker.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Protocol

import httpx

from app.config import settings
from app.schemas.matching import (
    SUPPORTED_SPECIALIZATIONS,
    MedicalProblemAnalysis,
)

logger = logging.getLogger("mediqo.ai")

# ---------------------------------------------------------------------------
# Emergency indicators — a deterministic safety net applied BEFORE any AI
# call. Anything matching is escalated to `emergency` and never diagnosed.
# Kept deliberately conservative: false positives are acceptable (better to
# over-warn), false negatives are not.
# ---------------------------------------------------------------------------
_EMERGENCY_PATTERNS: list[str] = [
    r"\bcrushing chest pain\b",
    r"\bchest pain\b",
    r"\bchest pressure\b",
    r"\bheart attack\b",
    r"\bcan'?t breathe\b",
    r"\bcannot breathe\b",
    r"\bcan'?t breathe properly\b",
    r"\bdifficulty breathing\b",
    r"\btrouble breathing\b",
    r"\bshortness of breath\b(?!.*(for weeks|for days|for months))",
    r"\bchoking\b",
    r"\bunconscious\b",
    r"\bpassed out\b",
    r"\bfainted\b",
    r"\bblack(ed)? out\b",
    r"\bseizure\b",
    r"\bfit(s)?\b",
    r"\bconvulsion\b",
    r"\bstroke\b",
    r"\bcan'?t move\b",
    r"\bcannot move\b",
    r"\bparaly(s|z)ed\b",
    r"\bslurred speech\b",
    r"\bsevere bleeding\b",
    r"\bbleeding heavily\b",
    r"\bblood everywhere\b",
    r"\bcoughing up blood\b",
    r"\bvomiting blood\b",
    r"\bblood in stool\b",
    r"\bsevere allergic reaction\b",
    r"\banaphyla(x|s)\b",
    r"\bsuicid(e|al)\b",
    r"\bkill myself\b",
    r"\bend my life\b",
    r"\boverdose\b",
    r"\bpoison(ing|ed)?\b",
    r"\bburn(ing)? badly\b",
    r"\bsevere burn\b",
    r"\bhead injury\b",
    r"\bskull fracture\b",
    r"\bbroken bone sticking\b",
    r"\bsudden (severe|worst) headache\b",
    r"\bworst headache\b",
    r"\bthunderclap headache\b",
    r"\bsudden (weakness|numbness) (on|in|of) one side\b",
    r"\bone side of (my|the) (body|face) (is )?(weak|numb|drooping)\b",
    r"\bwater broke\b",
    r"\bbaby not moving\b",
    r"\bpregnant and bleeding\b",
]

_EMERGENCY_SUMMARY = (
    "The description may indicate a medical emergency. "
    "Seek immediate emergency medical care."
)

# ---------------------------------------------------------------------------
# Rule-based specialty mapping (KeywordProvider)
# Each specialty has weighted symptom keywords; negations are respected.
# ---------------------------------------------------------------------------

# Words that flip a nearby symptom phrase into "not reported" (crude but
# effective negation handling for short MVP-style descriptions).
_NEGATORS = {"no", "not", "without", "deny", "denies", "never", "free"}

_SPECIALTY_KEYWORDS: dict[str, dict[str, int]] = {
    "Dentist": {
        "tooth": 4, "teeth": 4, "toothache": 5, "dental": 4, "gum": 3,
        "gums": 3, "molar": 4, "cavity": 3, "bleeding gums": 4, "jaw pain": 2,
        "wisdom tooth": 4, "bad breath": 2, "tongue": 2, "mouth ulcer": 3,
    },
    "Gastroenterologist": {
        "stomach": 4, "abdomen": 4, "abdominal": 4, "belly": 4, "digestion": 3,
        "digestive": 4, "vomit": 3, "vomiting": 4, "nausea": 3, "diarrhea": 4,
        "loose motion": 4, "constipation": 4, "acidity": 4, "acid reflux": 4,
        "heartburn": 4, "gas": 2, "bloating": 3, "appetite": 2, "liver": 3,
        "jaundice": 4, "gastric": 4, "food poisoning": 5, "indigestion": 4,
    },
    "Cardiologist": {
        "heart": 4, "palpitation": 5, "palpitations": 5, "chest pain": 4,
        "chest tightness": 4, "high blood pressure": 4, "blood pressure": 3,
        "cholesterol": 3, "irregular heartbeat": 5, "heart racing": 4,
        "pulse": 2, "bp": 2, "cardiac": 4,
    },
    "Dermatologist": {
        "skin": 4, "rash": 5, "itch": 3, "itching": 4, "itchy": 4,
        "acne": 5, "pimple": 4, "pimples": 4, "eczema": 5, "psoriasis": 5,
        "hair loss": 4, "hair fall": 4, "dandruff": 4, "pigmentation": 4,
        "mole": 3, "fungal": 4, "allergy rash": 5, "hives": 4, "boil": 2,
    },
    "Orthopedic": {
        "bone": 3, "joint": 4, "joints": 4, "knee": 4, "shoulder": 3,
        "back pain": 4, "backache": 4, "neck pain": 3, "fracture": 5,
        "sprain": 4, "swollen ankle": 4, "swollen knee": 4, "hip": 3,
        "spine": 3, "spondylosis": 4, "arthritis": 4, "twisted ankle": 4,
        "wrist": 2, "elbow": 2, "leg pain": 3, "muscle pain": 2,
    },
    "ENT Specialist": {
        "ear": 4, "ear pain": 5, "hearing": 4, "throat": 4, "sore throat": 5,
        "tonsil": 4, "sinus": 4, "sinusitis": 5, "blocked nose": 4,
        "stuffy nose": 4, "nose bleed": 4, "nosebleed": 4, "vertigo": 3,
        "dizzy spells": 2, "snoring": 3, "voice": 2, "hoarse": 3,
        "swallowing": 2, "ear ringing": 4, "tinnitus": 5,
    },
    "Pediatrician": {
        "child": 4, "children": 4, "kid": 3, "kids": 3, "baby": 5,
        "infant": 5, "toddler": 5, "newborn": 5, "my son": 4, "my daughter": 4,
        "vaccination": 5, "vaccine": 3, "growth": 2,
    },
    "Neurologist": {
        "headache": 3, "migraine": 5, "migraines": 5, "numbness": 4,
        "tingling": 4, "tremor": 5, "tremors": 5, "seizure": 4,
        "memory": 3, "dizziness": 3, "weakness in hands": 4,
        "weakness in legs": 4, "nerve": 3, "vertigo": 2, "balance": 2,
        "confusion": 2, "sleep problem": 1,
    },
    "Ophthalmologist": {
        "eye": 4, "eyes": 4, "vision": 5, "blurry vision": 5,
        "blurred vision": 5, "double vision": 5, "eye pain": 5,
        "red eye": 5, "red eyes": 5, "watering eyes": 4, "cataract": 5,
        "glaucoma": 5, "spectacles": 3, "glasses": 2, "dry eyes": 4,
        "itchy eyes": 4, "eye irritation": 4, "cannot see": 4,
    },
    "General Physician": {
        "fever": 4, "cold": 2, "cough": 3, "flu": 3, "tired": 2,
        "fatigue": 3, "weakness": 2, "body ache": 3, "headache": 1,
        "general checkup": 4, "checkup": 3, "weak": 2, "sick": 3,
        "unwell": 3, "malaise": 3, "seasonal illness": 3,
    },
}

# Compounds first so "chest pain" isn't also counted as plain "pain".
_SPECIALIZATION_ORDER = sorted(
    _SPECIALTY_KEYWORDS, key=lambda s: -max(len(k) for k in _SPECIALTY_KEYWORDS[s])
)


class AIProviderError(Exception):
    """Raised by providers when they cannot produce a valid analysis."""


class AIService(Protocol):
    """Interface for medical-problem analysis providers."""

    def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
        ...


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _has_negation_near(text_lower: str, keyword: str, position: int) -> bool:
    """True if a negator appears within 4 words before the keyword."""
    window_start = max(0, position - 40)
    before = text_lower[window_start:position]
    words = re.findall(r"[a-z']+", before)
    return any(word in _NEGATORS for word in words[-4:])


def detect_emergency(problem: str) -> bool:
    """Deterministic emergency pre-check. Applied before any AI call."""
    text_lower = problem.lower()
    return any(re.search(pattern, text_lower) for pattern in _EMERGENCY_PATTERNS)


def emergency_analysis() -> MedicalProblemAnalysis:
    """The fixed emergency response — never a diagnosis."""
    return MedicalProblemAnalysis(
        specialization="General Physician",
        urgency="emergency",
        summary=_EMERGENCY_SUMMARY,
        possible_keywords=[],
        source="emergency",
    )


def _validate_specialization(raw: object) -> str | None:
    """Return the exact supported specialization name, or None."""
    if not isinstance(raw, str):
        return None
    lowered = raw.strip().lower()
    for known in SUPPORTED_SPECIALIZATIONS:
        if known.lower() == lowered:
            return known
    return None


# ---------------------------------------------------------------------------
# KeywordProvider — offline deterministic analyzer (MVP default)
# ---------------------------------------------------------------------------

_URGENT_PATTERNS: list[str] = [
    # Deliberately conservative: bare "severe" stays "normal" (see the spec's
    # "I have severe tooth pain." -> normal example). These phrases indicate
    # rapid worsening rather than mere intensity.
    r"getting worse",
    r"\bworsening\b",
    r"\bunbearable\b",
    r"\brapidly\b",
    r"very high fever",
    r"\bfainting spells\b",
]


class KeywordProvider:
    """Deterministic rule-based analyzer. No network, no API key.

    Scores each supported specialty by weighted symptom keywords (with crude
    negation handling), then maps the raw score to a confidence band. Ties
    and low-confidence cases fall back to General Physician.
    """

    name = "keyword"

    def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
        text_lower = problem.lower()
        scores: dict[str, int] = {}
        matched: dict[str, list[str]] = {}

        for specialization in _SPECIALIZATION_ORDER:
            score = 0
            hits: list[str] = []
            for keyword, weight in _SPECIALTY_KEYWORDS[specialization].items():
                # \b boundaries prevent substring hits (e.g. "ear" inside
                # "unbearable"); the optional suffix keeps plurals working
                # ("knees" matches "knee").
                for match in re.finditer(rf"\b{re.escape(keyword)}(?:es|s)?\b", text_lower):
                    if _has_negation_near(text_lower, keyword, match.start()):
                        continue
                    score += weight
                    if keyword not in hits:
                        hits.append(keyword)
                    break  # count each keyword once per description
            if score > 0:
                if specialization == "Pediatrician":
                    # A child in the description should dominate symptom
                    # keywords elsewhere ("my child has stomach pain" ->
                    # Pediatrician, not Gastroenterologist).
                    score += 10
                scores[specialization] = score
                matched[specialization] = hits

        urgency: str = (
            "urgent" if any(re.search(p, text_lower) for p in _URGENT_PATTERNS) else "normal"
        )
        summary: str
        if not scores:
            specialization = "General Physician"
            summary = (
                "The description is not specific enough to identify a "
                "specialty; a General Physician may be a suitable starting "
                "point."
            )
        else:
            best = max(scores, key=lambda s: scores[s])
            top_score = scores[best]
            runner_up = max((v for s, v in scores.items() if s != best), default=0)
            if top_score < 4 or (runner_up > 0 and top_score < runner_up * 2):
                specialization = "General Physician"
                summary = (
                    "The description may relate to several areas; a General "
                    "Physician may be a suitable starting point."
                )
            else:
                specialization = best
                article = "An" if best[0].upper() in "AIEOU" else "A"
                summary = (
                    f"The user's description mentions: "
                    f"{', '.join(matched[best][:3])}. "
                    f"{article} {specialization} consultation may be appropriate."
                )

        keywords: list[str] = []
        for _, hits in sorted(matched.items(), key=lambda kv: -scores[kv[0]]):
            for hit in hits:
                if hit not in keywords:
                    keywords.append(hit)
        keywords = keywords[:5]

        return MedicalProblemAnalysis(
            specialization=specialization,
            urgency=urgency,
            summary=summary,
            possible_keywords=keywords,
        )


# ---------------------------------------------------------------------------
# OpenAIProvider — any OpenAI-compatible chat-completions API
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a medical-navigation classification assistant for Mediqo.

Your task is to understand a user's description and identify the most relevant
medical specialty from the supported specialty list.

You are NOT a doctor and must NOT diagnose the user. Never name diseases or
conditions. Only identify the likely type of medical professional/service
relevant to the description.

Return structured JSON only, exactly in this shape:
{"specialization": "<one of the supported specialties>",
 "urgency": "<normal|urgent|emergency>",
 "summary": "<one concise, non-diagnostic sentence>",
 "possible_keywords": ["<short symptom phrase>", ...]}

Supported specialties (use exactly these strings):
- General Physician
- Cardiologist
- Dermatologist
- Dentist
- Orthopedic
- Gastroenterologist
- ENT Specialist
- Pediatrician
- Neurologist
- Ophthalmologist

If the description suggests an emergency, classify urgency as "emergency" and
recommend immediate emergency medical care without attempting to diagnose.
Use only the supported specialties. If uncertain, use "General Physician".
Keep summaries concise. The possible_keywords are short symptom phrases from
the user's description, not diagnoses."""


class OpenAIProvider:
    """Provider for any OpenAI-compatible chat-completions endpoint.

    Configuration comes exclusively from Settings (env): AI_API_KEY,
    AI_MODEL, AI_BASE_URL, AI_TIMEOUT_SECONDS. The key is never logged and
    never included in error messages.
    """

    name = "openai"

    def __init__(self) -> None:
        if not settings.ai_api_key:
            raise AIProviderError("AI_API_KEY is not configured")
        self._api_key = settings.ai_api_key
        self._model = settings.ai_model
        self._base_url = settings.ai_base_url.rstrip("/")
        self._timeout = settings.ai_timeout_seconds

    def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
        try:
            response = httpx.post(
                f"{self._base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._model,
                    "messages": [
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user", "content": problem},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 300,
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
        except AIProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalized for the caller
            # Log the failure class only — never the key, never the user text.
            logger.warning("AI provider request failed: %s: %s",
                           type(exc).__name__, str(exc)[:120])
            raise AIProviderError("AI provider request failed") from exc

        analysis = self._parse_content(content)
        if analysis is None:
            raise AIProviderError("AI provider returned malformed output")
        return analysis

    @staticmethod
    def _parse_content(content: str) -> MedicalProblemAnalysis | None:
        """Parse the model's JSON (tolerating code fences) and validate it."""
        text = content.strip()
        fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
        if fence:
            text = fence.group(1)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        specialization = _validate_specialization(data.get("specialization"))
        if specialization is None:
            return None
        urgency = data.get("urgency")
        if urgency not in ("normal", "urgent", "emergency"):
            urgency = "normal"
        summary = data.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            summary = "A medical evaluation may be appropriate."
        keywords_raw = data.get("possible_keywords")
        keywords = [
            str(k).strip() for k in keywords_raw if isinstance(k, str) and k.strip()
        ][:5] if isinstance(keywords_raw, list) else []
        return MedicalProblemAnalysis(
            specialization=specialization,
            urgency=urgency,
            summary=summary.strip()[:500],
            possible_keywords=keywords,
        )


# ---------------------------------------------------------------------------
# Facade — the object the rest of the backend depends on
# ---------------------------------------------------------------------------

FALLBACK_ANALYSIS = MedicalProblemAnalysis(
    specialization="General Physician",
    urgency="normal",
    summary=(
        "We could not fully analyze the description. A General Physician "
        "may be a suitable starting point."
    ),
    possible_keywords=[],
)


class MediqoAIService:
    """Facade used by routes: safety net -> provider -> validated fallback.

    The internal `source` marker (provider | fallback | emergency) is not
    part of the public schema; the API layer strips it via response_model.
    """

    def __init__(self, provider: AIService) -> None:
        self._provider = provider

    @property
    def provider_name(self) -> str:
        return getattr(self._provider, "name", type(self._provider).__name__)

    def analyze_medical_problem(self, problem: str) -> MedicalProblemAnalysis:
        # 0. Defense in depth: never send blank input to any provider.
        text = problem.strip()
        if not text:
            raise ValueError("Problem description must not be empty or whitespace-only")

        # 1. Deterministic safety net FIRST — emergency is never sent for
        #    normal matching and never diagnosed, whatever the provider says.
        if detect_emergency(text):
            logger.info("Emergency indicators detected; bypassing provider")
            return emergency_analysis()

        # 2. Provider attempt with controlled failure.
        try:
            analysis = self._provider.analyze_medical_problem(text)
        except AIProviderError as exc:
            logger.warning("AI provider unavailable (%s); using safe fallback",
                           exc)
            return FALLBACK_ANALYSIS.model_copy(update={"source": "fallback"})

        # 3. Second emergency check on the provider's own output: if it
        #    classified emergency, adopt the fixed emergency response.
        if analysis.urgency == "emergency":
            return emergency_analysis()
        return analysis.model_copy(update={"source": "provider"})


def get_ai_service() -> AIService:
    """Build the configured provider; fall back to rules if unavailable."""
    provider_name = settings.ai_provider.strip().lower()
    if provider_name == "openai":
        try:
            return MediqoAIService(OpenAIProvider())
        except AIProviderError:
            logger.warning(
                "AI_PROVIDER=openai but no API key is configured; "
                "falling back to the offline keyword provider"
            )
    return MediqoAIService(KeywordProvider())
