import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../services/api";
import { useFlow } from "../state/FlowContext";
import type { MatchResponse, MatchResult } from "../types/api";
import { PageContainer } from "../components/layout/PageContainer";
import { Button } from "../components/ui/Button";
import { DoctorMatchCard } from "../components/mediqo/DoctorMatchCard";
import { MATCHING_STAGES, MatchingProgress } from "../components/mediqo/MatchingProgress";

const GENERIC_NETWORK =
  "We can't reach Mediqo right now. Please check your connection and try again.";

type Phase = "loading" | "success" | "no_match" | "emergency" | "error";

/**
 * Step 3 of the Mediqo flow: real doctor recommendations from the matching
 * engine (POST /match-doctors). Everything displayed — ranking, scores,
 * distances, reasons — comes verbatim from the backend; the frontend never
 * re-ranks or re-computes anything. This page owns the analysis + matching
 * hand-off, so unlike other pages it fetches on mount exactly once (via the
 * attempt counter, not the effect's closure — StrictMode-safe).
 */
export function ResultsPage() {
  const navigate = useNavigate();
  const { location, problem, resetFlow, setMatchResponse } = useFlow();

  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState(0);
  const [stage, setStage] = useState(0);
  const [response, setResponse] = useState<MatchResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const inflightRef = useRef(false);

  /* Flow guards: this step needs location + problem from the earlier steps. */
  useEffect(() => {
    if (!location) navigate("/location", { replace: true });
    else if (!problem) navigate("/problem", { replace: true });
  }, [location, problem, navigate]);

  const run = useCallback(async () => {
    /* Duplicate-request guard: StrictMode (dev) double-invokes effects, and
       this page must never POST /match-doctors twice for one submission. */
    if (inflightRef.current) return;
    if (
      !location ||
      !problem ||
      location.latitude === null ||
      location.longitude === null
    ) {
      if (location && problem) {
        setErrorMsg("We don't have usable coordinates for that location yet.");
        setPhase("error");
      }
      return;
    }
    setPhase("loading");
    setStage(0);
    setErrorMsg(null);
    inflightRef.current = true;
    try {
      const result = await api.matchDoctors({
        latitude: location.latitude,
        longitude: location.longitude,
        problem,
      });
      setResponse(result);
      setMatchResponse(result); // profile page reads its "why recommended" context from here
      if (result.status === "emergency") {
        setPhase("emergency");
      } else if (result.status === "no_match" || result.results.length === 0) {
        setPhase("no_match");
      } else {
        setPhase("success");
      }
    } catch (err) {
      setErrorMsg(
        err instanceof ApiError && err.kind === "network"
          ? GENERIC_NETWORK
          : "We couldn't load doctor recommendations. Please try again.",
      );
      setPhase("error");
    } finally {
      inflightRef.current = false;
    }
  }, [location, problem]);

  /* Focus the retry action when the error state appears. An effect (not a
     setTimeout in the catch) is deterministic: it runs after the error card
     commits, so the ref is guaranteed to be attached. */
  useEffect(() => {
    if (phase === "error") retryRef.current?.focus();
  }, [phase, attempt]);

  useEffect(() => {
    void run();
  }, [run, attempt]);

  /* Advance the pipeline narration while the real request is in flight. */
  useEffect(() => {
    if (phase !== "loading") return;
    const timer = setInterval(
      () => setStage((current) => Math.min(current + 1, MATCHING_STAGES.length - 1)),
      900,
    );
    return () => clearInterval(timer);
  }, [phase]);

  const startOver = useCallback(() => {
    resetFlow();
    navigate("/");
  }, [resetFlow, navigate]);

  return (
    <PageContainer className="pb-24 pt-10 sm:pt-14">
      {/* Back through the flow: results' previous step is the problem,
          not the landing page (home stays reachable via the wordmark). */}
      <Link
        to="/problem"
        className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink"
      >
        <span aria-hidden>←</span> Back
      </Link>

      {phase === "loading" && (
        <div className="mx-auto mt-16 w-full max-w-md">
          <MatchingProgress stage={stage} />
        </div>
      )}

      {phase === "error" && (
        <div className="mx-auto mt-16 w-full max-w-md">
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-card"
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
            <h2 className="font-display text-lg font-semibold text-ink">
              We couldn't load doctor recommendations
            </h2>
            <p className="max-w-sm text-[15px] leading-relaxed text-muted">{errorMsg}</p>
            <div className="mt-2 flex flex-col justify-center gap-3 sm:flex-row">
              <Button ref={retryRef} variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === "emergency" && (
        <div className="mx-auto mt-10 w-full max-w-lg rounded-xl border border-danger/25 bg-surface p-6 text-center shadow-card sm:p-8">
          <span
            aria-hidden
            className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-danger/30 bg-danger/10 font-display text-base font-semibold text-danger"
          >
            !
          </span>
          <h1 className="mt-4 font-display text-xl font-semibold text-ink sm:text-2xl">
            This may require immediate medical attention.
          </h1>
          <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
            Please contact your local emergency number or go to the nearest emergency
            department now. Mediqo doctor discovery is not for emergencies.
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Button variant="secondary" onClick={() => navigate("/")}>
              Back to home
            </Button>
            <Button variant="ghost" onClick={() => navigate("/problem")}>
              Edit description
            </Button>
          </div>
        </div>
      )}

      {phase === "no_match" && (
        <div className="mx-auto mt-16 w-full max-w-md">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-card">
            <h1 className="font-display text-lg font-semibold text-ink">
              We couldn't find a matching specialist nearby.
            </h1>
            <p className="max-w-sm text-[15px] leading-relaxed text-muted">
              {response?.message
                ? `${response.message} You can try describing your problem differently, or explore a General Physician.`
                : "You can try describing your problem differently, or explore a General Physician."}
            </p>
            <div className="mt-2 flex flex-col justify-center gap-3 sm:flex-row">
              <Button variant="secondary" onClick={() => navigate("/problem")}>
                Describe differently
              </Button>
              <Button variant="ghost" onClick={() => navigate("/location")}>
                Change location
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === "success" && response && (
        <>
          <header className="mt-6">
            <p className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
              Step 3 of 3
            </p>
            <h1 className="mt-2 text-[32px] font-semibold leading-tight text-ink sm:text-4xl">
              Doctors who may be suitable for you
            </h1>
            <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-muted sm:text-base">
              Based on your location and what you described.
            </p>

            <ul className="mt-5 flex flex-wrap items-center gap-2 text-[13px]">
              {problem && (
                <li className="max-w-full rounded-full border border-line bg-surface px-3.5 py-1.5 text-muted shadow-card">
                  <span className="text-faint">Problem: </span>
                  <span className="font-medium text-ink" title={problem}>
                    {problem.length > 42 ? `${problem.slice(0, 42)}…` : problem}
                  </span>
                </li>
              )}
              {response.analysis && (
                <li className="max-w-full rounded-full border border-line bg-surface px-3.5 py-1.5 text-muted shadow-card">
                  <span className="text-faint">Specialty: </span>
                  <span className="font-medium text-ink">{response.analysis.specialization}</span>
                </li>
              )}
              {location && (
                <li className="max-w-full rounded-full border border-line bg-surface px-3.5 py-1.5 text-muted shadow-card">
                  <span className="text-faint">Location: </span>
                  <span className="font-medium text-ink">{location.label}</span>
                </li>
              )}
            </ul>
          </header>

          {response.message && (
            <p
              role="status"
              className="mt-5 rounded-lg border border-accent-line bg-accent-soft/60 px-4 py-3 text-sm text-accent-strong"
            >
              {response.message}
            </p>
          )}

          <p className="mt-8 text-sm text-muted" aria-live="polite">
            {response.total_results} doctor{response.total_results === 1 ? "" : "s"} suitable for
            you
          </p>

          <ul className="mt-4 space-y-5">
            {response.results.map((result: MatchResult, index: number) => (
              <DoctorMatchCard key={result.doctor.id} result={result} rank={index} />
            ))}
          </ul>

          <p className="mx-auto mt-10 max-w-md text-center text-xs leading-relaxed text-faint">
            Mediqo suggests doctors who may be relevant — it is not a diagnosis and never
            replaces medical advice. Doctors shown are demo profiles for the Mediqo MVP.
          </p>
        </>
      )}
    </PageContainer>
  );
}
