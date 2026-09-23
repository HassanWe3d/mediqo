# Mediqo Frontend

React 19 + Vite 7 + TypeScript + Tailwind CSS 3.4 (pure-JS pipeline — chosen
over v4 because v4's native Rust engine hits a Node 24.16 N-API regression on
this machine; tokens are identical). Typography-first, token-driven, one
deep-viridian accent. No UI mega-libraries.

## Setup

```bash
cd frontend
npm install
cp .env.example .env        # VITE_API_BASE_URL=http://127.0.0.1:8000
npm run dev                 # http://localhost:5173
```

Scripts: `dev`, `build` (typecheck + production build), `typecheck`, `preview`.

## Design system

Tokens live in `tailwind.config.ts` (mirrored accents in `src/index.css`):
surfaces (`bg`, `surface`), ink
scale (`ink`, `ink-soft`, `muted`, `faint`), lines, the single accent
(`#0E7C66` viridian + soft tint), feedback colors, radii, two soft shadows,
and the motion vocabulary (160ms fast / 420ms slow, `--ease-out-soft`).

Fonts are self-hosted via Fontsource — **Sora** (display) and **Inter**
(body) — no runtime Google Fonts dependency.

## Component provenance

Adapted from React Bits / UIverse patterns, rebuilt small and native to the
Mediqo token system (nothing pasted verbatim):

| Mediqo component | Inspiration |
|---|---|
| `mediqo/FadeReveal` | React Bits — Animated Content (reduced to one calm motion) |
| `ui/PulseDots` | UIverse — loader patterns |
| `ui/Button` tactile press + focus ring | React Bits buttons (general pattern) |
| `landing/Hero` cartographic grid backdrop | React Bits background family (grid pattern, static + CSS-only) |

## Landing page (Step 9.2)

`pages/LandingPage.tsx` composes four sections in `components/landing/`:
`Hero` (editorial copy + the 3-card product-flow visual), `FlowSteps`
(numbered editorial columns, no cards), `Differentiator` (the "you don't
need to know the specialty" statement + mechanism demo), and `FinalCta`.
Header anchors (`/#how-it-works`, `/#why-mediqo`) scroll via
`hooks/useScrollToHash`. No fake doctors, names, or statistics anywhere —
the visual demonstrates the mechanism, not invented data.

## Location experience (Step 9.3)

`pages/LocationPage.tsx` — "Where are you?" — implements the full spec: the
permission prompt fires only from the "Allow Location" click (never on
load); a browser fix is verified by `POST /location/validate`; the manual
city fallback resolves via `POST /location/manual`; every failure mode
(denied, unavailable, timeout, unsupported browser, backend down, network
down, unsupported/empty city) has friendly copy and a way forward (retry
and/or the manual panel). Success offers "Continue" to `/problem`.

Supporting pieces: `hooks/useGeolocation` (wraps
`navigator.geolocation`, maps error **codes 1/2/3** to a closed status set),
`state/FlowContext` (lightweight context carrying the chosen location
across `/location` → `/problem` → `/results` — React state +
`sessionStorage` only, never persisted permanently), and
`mediqo/LocationVisual` (decorative map-inspired visual: cartographic
grid, range rings, crosshair ticks, one accent pin; a subtle radar ring
only while seeking, disabled under reduced motion).

## Problem experience (Step 9.4)

`pages/ProblemPage.tsx` — "What are you experiencing?" — the free-text
problem step (no specialty picker, by design): a large Textarea (backend
limit 1000 chars, live counter), clickable example prompts (populate
only — never auto-submit), a quiet location chip with a "Change" action,
and a premium analyzing state ("Understanding your concern…"). Submit
calls `POST /analyze-problem` via the API client; the analysis is stored
in flow state and normal/urgent urgency continues to `/results` while
`urgency: "emergency"` shows the emergency screen (no matching, no
diagnosis — the backend urgency gate remains the source of truth).

Supporting pieces: `ui/Textarea` (label/error/counter + a self-healing
controlled value that reconciles DOM drift from history restoration or
autofill), `FlowContext` extended with `problem` + `analysis`
(sessionStorage only, never persisted permanently), a no-location guard
that redirects to `/location`, and draft persistence so the problem
survives location changes and failed submissions.

## Problem QA

`npm run qa:problem` runs `tests/problem-qa.mjs` — 70 checks: deterministic
mocked scenarios (render/guard/validation/limit/examples/success/emergency/
failure/recovery/network/change-location), live runs against the real
backend AI (tooth pain, rash, blurry vision → /results; chest pain →
emergency), a 6-viewport responsive sweep, axe accessibility, keyboard
traversal, and reduced-motion behavior.

## Results QA

`npm run qa:results` runs `tests/results-qa.mjs` — 86 checks: deterministic
mocked matching scenarios (render, exactly-one POST /match-doctors, request
payload, loading narration, backend order preservation, no_match, emergency,
HTTP + network failure recovery, flow-state guards), live runs against the
REAL backend (tooth pain → Dentist, rash → Dermatologist, blurry vision →
Ophthalmologist; cross-checked against direct API calls), a 6-viewport
responsive sweep, axe accessibility, element-identity keyboard traversal,
and reduced-motion behavior.

## Final QA (Step 9.7)

Three additional harnesses cover the whole product rather than single
pages:

- `npm run qa:e2e` — `tests/e2e-final-qa.mjs` (59 checks): clicks-only
  full journeys against the live stack (tooth pain / rash / blurry vision
  with real AI + matching + PostgreSQL), emergency flow (zero
  /match-doctors calls), permission-deny fallback, browser
  back/forward/refresh, direct URLs including invalid ids, and static
  source-of-truth audits (no re-ranking, no recomputed scores, no
  hardcoded doctors/reviews, base URL only in the API client).
- `npm run qa:design` — `tests/design-qa.mjs` (59 checks): 7-viewport
  sweep (320–1920) across all five pages, per-page axe audits, design
  token metrics (radii/shadows/type bands), and results-page conformance
  against the live POST /match-doctors response (scores, distances and
  reasons must equal the API exactly).
- `npm run qa:prod` — `tests/prod-smoke.mjs` (9 checks): builds dist and
  serves the real production bundle via `vite preview` (briefly pausing
  the dev server to satisfy the backend CORS allowlist), verifying every
  route boots without the dev server.

## Doctor profile QA

`npm run qa:doctor` runs `tests/doctor-profile-qa.mjs` — 70 checks:
deterministic mocked scenarios (all profile fields, reviews, match context
only when the flow provides it, empty/404/network/review-failure states,
invalid ids), a LIVE journey through the real backend (results → View
Profile → real PostgreSQL reviews → back to results), a 6-viewport
responsive sweep, axe accessibility, keyboard traversal, and reduced-motion
behavior.

## Location QA

`npm run qa:location` runs `tests/location-qa.mjs` — 68 checks in three
parts: (A) deterministic mocked scenarios (geo success/denied/unavailable/
timeout/unsupported, backend 503, network failure, manual city paths, no
API on load, SPA state preservation), (B) live runs against the REAL
backend with real browser geolocation permission + CDP GPS emulation, and
(C) responsive sweep (320–1440), axe accessibility on the manual panel,
keyboard traversal, and reduced-motion emulation.

## Landing page QA

`npm run qa:landing` runs `tests/landing-qa.mjs` — a real-browser harness
(puppeteer-core + system Chrome + axe-core; dev-only, no runtime weight)
covering functional checks, a 7-viewport responsive sweep, accessibility,
reduced-motion emulation, CLS, and network/console audits.

## API layer

`src/services/api.ts` is the only place that talks to the backend (base URL
from `VITE_API_BASE_URL`). Errors normalize to `ApiError` with friendly,
user-safe messages. Types in `src/types/api.ts` mirror the verified backend
schemas exactly.

## Routes

`/` landing · `/location` · `/problem` · `/results` · `/doctor/:id` —
all five routes are full experiences as of Step 9.6: the doctor profile
fetches the real doctor + reviews from PostgreSQL, shows the matching
context from flow state when present, and labels every demo record.

## Honest product rules

- No fake doctors, reviews, or statistics. Demo records carry `is_demo`
  and are always labelled.
- Coordinates are session data only; the frontend never stores them.
- Not a diagnostic service — emergency responses route to emergency care.
