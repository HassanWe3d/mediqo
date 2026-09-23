import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../services/api";
import { useFlow } from "../state/FlowContext";
import { useGeolocation, type GeoFix } from "../hooks/useGeolocation";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { PageContainer } from "../components/layout/PageContainer";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { FadeReveal } from "../components/mediqo/FadeReveal";
import { LocationVisual } from "../components/mediqo/LocationVisual";

const GENERIC_NETWORK =
  "We can't reach Mediqo right now. Please check your connection and try again.";

type Mode = "auto" | "manual";

/**
 * Step 1 of the Mediqo flow: where are you?
 *
 * The browser permission prompt only ever happens because the user
 * pressed "Allow Location" (never on page load). A successful fix is
 * verified by the backend (POST /location/validate); the manual path is
 * resolved by POST /location/manual. Every outcome — denied, unavailable,
 * unsupported, backend down, unsupported city — has a friendly way
 * forward. Precise coordinates are kept in session flow state only.
 */
export function LocationPage() {
  const navigate = useNavigate();
  const { location, setLocation } = useFlow();
  const geo = useGeolocation();
  const reducedMotion = usePrefersReducedMotion();

  const [mode, setMode] = useState<Mode>("auto");
  const [validating, setValidating] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [city, setCity] = useState("");
  const [manualChecking, setManualChecking] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [awaitFocus, setAwaitFocus] = useState(false);

  const manualInputRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  /* Browser fix received → verify it with the backend, then save state. */
  const verifyFix = useCallback(
    async (fix: GeoFix) => {
      setValidating(true);
      setAutoError(null);
      try {
        const result = await api.validateLocation({ latitude: fix.latitude, longitude: fix.longitude });
        setLocation({
          method: "browser",
          label: "Your current location",
          latitude: result.latitude,
          longitude: result.longitude,
        });
        setAwaitFocus(true);
      } catch (error) {
        setAutoError(error instanceof ApiError ? error.message : GENERIC_NETWORK);
      } finally {
        setValidating(false);
      }
    },
    [setLocation],
  );

  useEffect(() => {
    if (geo.status === "success" && geo.fix) void verifyFix(geo.fix);
  }, [geo.status, geo.fix, verifyFix]);

  /* Move focus to "Continue" when a fresh location arrives from a user action. */
  useEffect(() => {
    if (awaitFocus && location) {
      continueRef.current?.focus();
      setAwaitFocus(false);
    }
  }, [awaitFocus, location]);

  /* Focus the city input when the manual panel opens. */
  useEffect(() => {
    if (mode === "manual") manualInputRef.current?.focus();
  }, [mode]);

  const retryAuto = useCallback(() => {
    setAutoError(null);
    if (geo.fix) void verifyFix(geo.fix);
    else geo.request();
  }, [geo, verifyFix]);

  const openManual = useCallback(() => {
    setMode("manual");
    setManualError(null);
  }, []);

  const submitCity = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = city.trim();
      if (!trimmed) {
        setManualError("Please enter a city.");
        return;
      }
      setManualChecking(true);
      setManualError(null);
      try {
        const result = await api.manualLocation(trimmed);
        setLocation({
          method: "city",
          label: result.city,
          latitude: result.latitude,
          longitude: result.longitude,
        });
        setMode("auto");
        setAwaitFocus(true);
      } catch (error) {
        setManualError(error instanceof ApiError ? error.message : GENERIC_NETWORK);
      } finally {
        setManualChecking(false);
      }
    },
    [city, setLocation],
  );

  const locating = geo.status === "locating" || validating;
  const tone = locating ? "seeking" : location ? "found" : "idle";

  /* ------- error copy (never raw exceptions) ------- */
  const autoFailure =
    autoError !== null
      ? {
          title: "We couldn't verify your location.",
          message: autoError,
          primary: "try" as const,
        }
      : geo.status === "denied"
        ? {
            title: "Location access was denied.",
            message: "You can enter your city manually instead.",
            primary: "manual" as const,
          }
        : geo.status === "unsupported"
          ? {
              title: "Location services are not available in this browser.",
              message: "You can enter your city manually instead.",
              primary: "manual" as const,
            }
          : geo.status === "unavailable" || geo.status === "timeout"
            ? {
                title: "We couldn't determine your location.",
                message: "Try again, or enter your city manually.",
                primary: "try" as const,
              }
            : null;

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
          Step 1 of 3
        </p>
        <h1 className="text-[32px] font-semibold leading-tight text-ink sm:text-4xl">Where are you?</h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-muted sm:text-base">
          Allow Mediqo to use your location to find suitable doctors nearby.
        </p>
      </FadeReveal>

      <FadeReveal delay={90} className="mt-10">
        <LocationVisual tone={tone} />
      </FadeReveal>

      <FadeReveal
        delay={140}
        className="relative z-10 mx-auto -mt-20 w-[calc(100%-2.5rem)] max-w-md sm:-mt-24 sm:w-[calc(100%-8rem)]"
      >
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card sm:p-8">
          {/* ----- verifying ----- */}
          {validating && (
            <div aria-live="polite" className="flex flex-col items-center gap-3 py-4 text-center">
              <Spinner size={22} className="text-accent" />
              <p className="text-[15px] text-ink-soft">Verifying your location…</p>
            </div>
          )}

          {/* ----- manual panel ----- */}
          {!validating && mode === "manual" && (
            <form onSubmit={submitCity} noValidate>
              <h2 className="font-display text-lg font-semibold text-ink">Enter your city</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                We'll match it against the cities where Mediqo doctors are available.
              </p>
              <div className="mt-5">
                <Input
                  ref={manualInputRef}
                  label="City"
                  name="city"
                  placeholder="e.g. Lucknow"
                  autoComplete="off"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  error={manualError ?? undefined}
                />
              </div>
              <p className="mt-2 text-xs text-faint">
                Demo doctors are currently available in Lucknow and a few nearby cities.
              </p>
              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <Button type="submit" loading={manualChecking} className="sm:flex-1">
                  Continue
                </Button>
                <Button type="button" variant="ghost" onClick={() => setMode("auto")}>
                  Use automatic detection
                </Button>
              </div>
            </form>
          )}

          {/* ----- success ----- */}
          {!validating && mode === "auto" && location && (
            <div aria-live="polite">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-sm font-semibold text-accent"
                >
                  ✓
                </span>
                <div>
                  <h2 className="font-display text-lg font-semibold text-ink">Location detected</h2>
                  <p className="text-sm text-muted">{location.label}</p>
                </div>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-faint">
                Used only to find doctors nearby — kept for this session, never stored permanently.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Button ref={continueRef} size="lg" className="sm:flex-1" onClick={() => navigate("/problem")}>
                  Continue
                </Button>
                {location.method === "browser" ? (
                  <Button variant="ghost" onClick={openManual}>
                    Enter a different city
                  </Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={openManual}>
                      Enter a different city
                    </Button>
                    <Button variant="ghost" onClick={geo.request}>
                      Use my current location
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ----- auto failures ----- */}
          {!validating && mode === "auto" && !location && autoFailure && (
            <div role="alert" className="text-center">
              <h2 className="font-display text-lg font-semibold text-ink">{autoFailure.title}</h2>
              <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted">
                {autoFailure.message}
              </p>
              <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                {autoFailure.primary === "manual" ? (
                  <>
                    <Button onClick={openManual}>Enter location manually</Button>
                    <Button variant="ghost" onClick={retryAuto}>
                      Try again
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={retryAuto}>Try again</Button>
                    <Button variant="ghost" onClick={openManual}>
                      Enter location manually
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ----- idle / locating ----- */}
          {!validating && mode === "auto" && !location && !autoFailure && (
            <div className="flex flex-col items-center text-center">
              <Button
                size="lg"
                loading={geo.status === "locating"}
                onClick={geo.request}
                className="w-full sm:w-auto"
              >
                {geo.status === "locating" ? "Finding your location…" : "Allow Location"}
              </Button>
              <p aria-live="polite" className="mt-3 h-5 text-xs text-faint">
                {geo.status === "locating"
                  ? reducedMotion
                    ? "This usually takes a few seconds."
                    : "This usually takes a few seconds — your browser will ask for permission."
                  : ""}
              </p>
              <Button variant="ghost" onClick={openManual} className="mt-3 underline decoration-line-strong underline-offset-4 hover:decoration-ink-soft">
                Enter location manually
              </Button>
            </div>
          )}
        </div>
      </FadeReveal>

      <p className="mx-auto mt-6 max-w-md text-center text-xs leading-relaxed text-faint">
        Your location stays in this session and is used only to find doctors nearby.
      </p>
    </PageContainer>
  );
}
