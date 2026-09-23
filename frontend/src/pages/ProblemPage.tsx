import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../services/api";
import { useFlow } from "../state/FlowContext";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { PageContainer } from "../components/layout/PageContainer";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Textarea";
import { FadeReveal } from "../components/mediqo/FadeReveal";
import { PulseDots } from "../components/ui/PulseDots";

/** Mirrors the backend contract (app/schemas/matching.py, Step 5/7). */
const MAX_PROBLEM_LENGTH = 1000;

const GENERIC_NETWORK =
  "We can't reach Mediqo right now. Please check your connection and try again.";

const EXAMPLES = ["Tooth pain", "Skin rash", "Blurry vision", "Stomach pain", "Child has fever"] as const;

type Phase = "input" | "analyzing" | "emergency" | "error";

/**
 * Step 2 of the Mediqo flow: what are you experiencing?
 *
 * The user describes their problem in their own words — Mediqo (via the
 * backend AI service, POST /analyze-problem) works out which kind of
 * doctor is relevant. The page never suggests the user has been
 * diagnosed: the analysis is surfaced as navigation guidance, and
 * emergency-looking descriptions are routed to emergency care instead
 * of doctor matching (the backend remains the source of truth).
 */
export function ProblemPage() {
  const navigate = useNavigate();
  const { location, problem, setProblem, setAnalysis } = useFlow();
  const reducedMotion = usePrefersReducedMotion();

  const [text, setText] = useState(problem ?? "");
  const [phase, setPhase] = useState<Phase>("input");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const invalid = text.trim().length > 0 && text.trim().length < 3;

  /* Flow guard: the problem step needs a location (Step 9.3 hand-off). */
  useEffect(() => {
    if (!location) navigate("/location", { replace: true });
  }, [location, navigate]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      setValidationError(
        trimmed.length === 0
          ? "Please describe what you're experiencing."
          : "Please add a little more detail (at least 3 characters).",
      );
      textareaRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_PROBLEM_LENGTH) {
      setValidationError(`Please keep it under ${MAX_PROBLEM_LENGTH} characters.`);
      textareaRef.current?.focus();
      return;
    }

    setValidationError(null);
    setSubmitError(null);
    setPhase("analyzing");
    try {
      const result = await api.analyzeProblem(trimmed);
      setProblem(trimmed);
      setAnalysis(result);
      if (result.urgency === "emergency") {
        setPhase("emergency");
      } else {
        navigate("/results");
      }
    } catch (err) {
      setSubmitError(
        err instanceof ApiError && err.kind === "network"
          ? GENERIC_NETWORK
          : "We couldn't analyze that right now. Please try again.",
      );
      setPhase("error");
      setTimeout(() => retryRef.current?.focus(), 0);
    }
  }, [text, navigate, setProblem, setAnalysis]);

  const useExample = useCallback((example: string) => {
    setText(example);
    setValidationError(null);
    textareaRef.current?.focus();
  }, []);

  return (
    <PageContainer className="pb-24 pt-10 sm:pt-14">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink"
      >
        <span aria-hidden>←</span> Back
      </Link>

      <FadeReveal className="mt-6 flex flex-col items-start gap-2">
        <p className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          Step 2 of 3
        </p>
        <h1 className="text-[32px] font-semibold leading-tight text-ink sm:text-4xl">
          What are you experiencing?
        </h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-muted sm:text-base">
          Describe your problem in your own words. You don't need to know which specialist
          you need.
        </p>
      </FadeReveal>

      {location && (
        <FadeReveal delay={60} className="mt-5">
          <p className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-muted shadow-card">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="truncate">
              Location confirmed: <span className="font-medium text-ink">{location.label}</span>
            </span>
            <Link
              to="/location"
              className="shrink-0 rounded-full font-medium text-accent underline decoration-accent-line underline-offset-4 transition-colors hover:text-accent-strong"
            >
              Change
            </Link>
          </p>
        </FadeReveal>
      )}

      <FadeReveal delay={110} className="mx-auto mt-10 w-full max-w-2xl">
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card sm:p-8">
          {phase === "emergency" ? (
            <div role="alert" className="text-center">
              <span
                aria-hidden
                className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-danger/30 bg-danger/10 font-display text-base font-semibold text-danger"
              >
                !
              </span>
              <h2 className="mt-4 font-display text-xl font-semibold text-ink">
                This may require immediate medical attention.
              </h2>
              <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
                Please contact your local emergency number or go to the nearest emergency
                department now. Mediqo doctor discovery is not for emergencies.
              </p>
              <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                <Button variant="secondary" onClick={() => navigate("/")}>
                  Back to home
                </Button>
                <Button variant="ghost" onClick={() => setPhase("input")}>
                  Edit description
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Loading panel. The form stays MOUNTED underneath (hidden)
                  while analyzing: unmount/remount would drop the textarea's
                  DOM value on the error path. */}
              {phase === "analyzing" && (
                <div aria-live="polite" aria-busy="true" className="flex flex-col items-center gap-4 py-10 text-center">
                  <PulseDots className="text-accent" />
                  <div>
                    <p className="font-display text-lg font-semibold text-ink">
                      Understanding your concern…
                    </p>
                    {!reducedMotion && (
                      <p className="mt-1 text-sm text-muted">Finding the right medical specialty…</p>
                    )}
                  </div>
                </div>
              )}
              <div className={phase === "analyzing" ? "hidden" : ""}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                noValidate
              >
                <Textarea
                  ref={textareaRef}
                  label="Your symptoms or concern"
                  placeholder="I've been having…"
                  value={text}
                  maxLength={MAX_PROBLEM_LENGTH}
                  hint="For example: where it hurts, when it started, and how it's been changing."
                  error={validationError ?? undefined}
                  onChange={(e) => {
                    setText(e.target.value);
                    // Draft persists through "Change location" round-trips;
                    // a successful submit overwrites it with the trimmed value.
                    setProblem(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                />

                <div className="mt-5">
                  <p className="text-[13px] font-medium text-ink-soft" id="examples-label">
                    Not sure how to phrase it? Try:
                  </p>
                  <div
                    role="group"
                    aria-labelledby="examples-label"
                    className="mt-2.5 flex flex-wrap gap-2"
                  >
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => useExample(example)}
                        className="rounded-full border border-line bg-surface-soft/60 px-3.5 py-2 text-[13px] text-ink-soft transition-colors duration-[160ms] hover:border-accent-line hover:bg-accent-soft/60 hover:text-accent-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  className="mt-7 w-full sm:w-auto"
                  disabled={invalid}
                >
                  Find suitable doctors
                </Button>
                <p aria-live="polite" className="mt-3 h-5 text-xs text-faint">
                  {invalid ? "Please add a little more detail." : ""}
                </p>
              </form>

              {phase === "error" && submitError && (
                <div
                  role="alert"
                  className="mt-6 flex flex-col items-start gap-3 rounded-lg border border-danger/25 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="text-sm text-ink-soft">{submitError}</p>
                  <Button ref={retryRef} size="md" onClick={() => void submit()}>
                    Try again
                  </Button>
                </div>
              )}
              </div>
            </>
          )}
        </div>
      </FadeReveal>

      <p className="mx-auto mt-6 max-w-md text-center text-xs leading-relaxed text-faint">
        Mediqo suggests the kind of doctor that may be relevant — it is not a diagnosis and
        never replaces medical advice.
      </p>
    </PageContainer>
  );
}