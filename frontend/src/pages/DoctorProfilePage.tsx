import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../services/api";
import { useFlow } from "../state/FlowContext";
import type { DoctorDetail, DoctorReviewsResponse, MatchResult } from "../types/api";
import { availabilityRows, doctorInitials, feeDisplay, ratingOutOfFive, reviewDate } from "../utils/format";
import { PageContainer } from "../components/layout/PageContainer";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";

type DoctorPhase = "loading" | "success" | "not_found" | "error";
type ReviewsPhase = "idle" | "loading" | "success" | "error";

function Stars({ rating, label }: { rating: number; label?: string }) {
  const full = Math.round(rating);
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={label ?? `Rated ${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} aria-hidden className={star <= full ? "text-accent" : "text-line-strong"}>
          ★
        </span>
      ))}
    </span>
  );
}

function SkeletonCard({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-soft ${className}`} aria-hidden />;
}

function ProfileSkeleton() {
  return (
    <div className="mt-8 space-y-5" aria-hidden>
      <Card className="p-6">
        <div className="flex items-start gap-5">
          <SkeletonCard className="h-16 w-16 rounded-2xl" />
          <div className="flex-1 space-y-3 pt-1">
            <SkeletonCard className="h-6 w-56" />
            <SkeletonCard className="h-4 w-40" />
            <SkeletonCard className="h-4 w-72" />
          </div>
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          <Card className="space-y-3 p-6">
            <SkeletonCard className="h-4 w-24" />
            <SkeletonCard className="h-4 w-full" />
            <SkeletonCard className="h-4 w-4/5" />
          </Card>
          <Card className="space-y-3 p-6">
            <SkeletonCard className="h-4 w-28" />
            <SkeletonCard className="h-4 w-3/5" />
          </Card>
        </div>
        <Card className="h-fit space-y-3 p-6">
          <SkeletonCard className="h-8 w-24" />
          <SkeletonCard className="h-4 w-40" />
          <SkeletonCard className="h-4 w-48" />
        </Card>
      </div>
    </div>
  );
}

function ReviewsSkeleton() {
  return (
    <div className="mt-5 space-y-4" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="border-t border-line pt-4">
          <SkeletonCard className="h-4 w-24" />
          <SkeletonCard className="mt-2 h-4 w-full" />
          <SkeletonCard className="mt-1.5 h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function DoctorProfilePage() {
  const { id } = useParams<{ id: string }>();
  const doctorId = Number.parseInt(id ?? "", 10);
  const hasValidId = Number.isFinite(doctorId) && doctorId > 0;

  const { matchResponse } = useFlow();

  const [phase, setPhase] = useState<DoctorPhase>("loading");
  const [doctor, setDoctor] = useState<DoctorDetail | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inflightRef = useRef(false);

  const [reviewsPhase, setReviewsPhase] = useState<ReviewsPhase>("idle");
  const [reviews, setReviews] = useState<DoctorReviewsResponse | null>(null);
  const [reviewsAttempt, setReviewsAttempt] = useState(0);
  const reviewsInflightRef = useRef(false);

  /* ---- Doctor: GET /doctors/{id} (once per attempt — StrictMode-safe) ---- */
  useEffect(() => {
    if (!hasValidId) {
      setPhase("not_found");
      return;
    }
    if (inflightRef.current) return;
    inflightRef.current = true;
    setPhase("loading");
    setErrorMsg(null);
    api
      .getDoctor(doctorId)
      .then((detail) => {
        setDoctor(detail);
        setPhase("success");
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setPhase("not_found");
        } else {
          setErrorMsg(err instanceof ApiError ? err.message : "We couldn't load this doctor's profile.");
          setPhase("error");
        }
      })
      .finally(() => {
        inflightRef.current = false;
      });
  }, [doctorId, hasValidId, attempt]);

  /* ---- Reviews: GET /doctors/{id}/reviews — independent, quieter failure ---- */
  useEffect(() => {
    if (phase !== "success" || !hasValidId) return;
    if (reviewsInflightRef.current) return;
    reviewsInflightRef.current = true;
    setReviewsPhase("loading");
    api
      .getDoctorReviews(doctorId, 1, 10)
      .then((data) => {
        setReviews(data);
        setReviewsPhase("success");
      })
      .catch(() => {
        setReviewsPhase("error");
      })
      .finally(() => {
        reviewsInflightRef.current = false;
      });
  }, [phase, doctorId, hasValidId, reviewsAttempt]);

  const retryReviews = useCallback(() => setReviewsAttempt((a) => a + 1), []);

  /* The real "why recommended" from the flow's matching response — never
     regenerated or invented here; absent on direct visits, which is fine. */
  const matchResult: MatchResult | null =
    matchResponse?.status === "success"
      ? (matchResponse.results.find((r) => r.doctor.id === doctorId) ?? null)
      : null;

  const backTo = matchResponse ? "/results" : "/";

  if (phase === "not_found") {
    return (
      <PageContainer className="py-20">
        <div
          role="alert"
          className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-card"
        >
          <h1 className="font-display text-lg font-semibold text-ink">We couldn't find this doctor's profile.</h1>
          <p className="text-[15px] leading-relaxed text-muted">
            The profile may not exist, or the link may be out of date.
          </p>
          <Link to={backTo} className="mt-2">
            <Button variant="secondary" size="md">
              Back to doctors
            </Button>
          </Link>
        </div>
      </PageContainer>
    );
  }

  if (phase === "error") {
    return (
      <PageContainer className="py-20">
        <ErrorState
          title="We couldn't load this doctor's profile."
          message={errorMsg ?? "Please try again in a moment."}
          onRetry={() => setAttempt((a) => a + 1)}
          className="mx-auto max-w-md"
        />
      </PageContainer>
    );
  }

  if (phase === "loading" || !doctor) {
    return (
      <PageContainer width="wide" className="pb-24 pt-10">
        <Link to={backTo} className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink">
          <span aria-hidden>←</span> Back to doctors
        </Link>
        <ProfileSkeleton />
        <span className="sr-only" role="status">
          Loading profile…
        </span>
      </PageContainer>
    );
  }

  const rows = availabilityRows(doctor.availability);

  return (
    <PageContainer width="wide" className="pb-24 pt-10">
      <Link
        to={backTo}
        className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink"
      >
        <span aria-hidden>←</span> Back to doctors
      </Link>

      {/* ---- Profile header ---- */}
      <Card as="article" className="mt-6 p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          {doctor.profile_image ? (
            <img
              src={doctor.profile_image}
              alt={`Portrait of ${doctor.name}`}
              className="h-16 w-16 shrink-0 rounded-2xl border border-line object-cover sm:h-20 sm:w-20"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 select-none items-center justify-center rounded-2xl border border-accent-line bg-accent-soft font-display text-xl font-semibold text-accent-strong sm:h-20 sm:w-20 sm:text-2xl"
            >
              {doctorInitials(doctor.name)}
            </span>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-3xl">{doctor.name}</h1>
              {doctor.is_demo && <Badge variant="demo">Demo profile</Badge>}
              {doctor.verified && <Badge variant="success">Verified</Badge>}
            </div>
            <p className="mt-1.5 text-[15px]">
              <span className="font-medium text-ink-soft">{doctor.specialization}</span>
              <span aria-hidden className="text-faint"> · </span>
              <span className="text-muted">{doctor.qualification}</span>
            </p>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <Stars rating={doctor.rating} label={ratingOutOfFive(doctor.rating)} />
              <span className="font-medium text-ink">{doctor.rating.toFixed(1)}</span>
              <span aria-hidden className="text-faint">·</span>
              <span className="text-muted">{doctor.review_count} reviews</span>
              <span aria-hidden className="text-faint">·</span>
              <span className="text-muted">{doctor.experience_years} years experience</span>
            </p>
            <p className="mt-1.5 text-sm text-muted">
              {doctor.clinic_name} · {doctor.city}
            </p>
          </div>
        </div>
      </Card>

      {/* ---- Match context (only when the user arrived through matching) ---- */}
      {matchResult && (
        <section aria-labelledby="match-context-heading" className="mt-5">
          <Card className="border-accent-line bg-accent-soft/40 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="match-context-heading" className="font-display text-base font-semibold text-ink">
                Why this doctor was recommended
              </h2>
              <Badge variant="accent">{matchResult.match_score}% match</Badge>
            </div>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {matchResult.match_reasons.map((reason) => (
                <li key={reason}>
                  <Badge variant="neutral">{reason}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* ---- Details grid ---- */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          {doctor.bio && (
            <section aria-labelledby="about-heading">
              <Card className="p-6">
                <h2 id="about-heading" className="font-display text-base font-semibold text-ink">
                  About
                </h2>
                <p className="mt-2.5 max-w-prose text-[15px] leading-relaxed text-muted">{doctor.bio}</p>
              </Card>
            </section>
          )}

          <section aria-labelledby="availability-heading">
            <Card className="p-6">
              <h2 id="availability-heading" className="font-display text-base font-semibold text-ink">
                Availability
              </h2>
              {rows.length > 0 ? (
                <dl className="mt-3 space-y-1.5 text-[15px]">
                  {rows.map((row) => (
                    <div key={row.days} className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <dt className="text-muted">{row.days}</dt>
                      <dd className="font-medium text-ink-soft">{row.hours}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-2.5 text-[15px] text-muted">{doctor.availability_summary}</p>
              )}
              <p className="mt-3 text-xs text-faint">Schedules are provided as sample data and may change.</p>
            </Card>
          </section>
        </div>

        <div className="space-y-5">
          <section aria-labelledby="visit-heading">
            <Card className="p-6">
              <h2 id="visit-heading" className="font-display text-base font-semibold text-ink">
                Consultation
              </h2>
              <p className="mt-2 font-display text-2xl font-semibold text-ink">{feeDisplay(doctor.consultation_fee)}</p>
              <p className="text-xs text-faint">per consultation</p>
              <dl className="mt-4 space-y-2.5 text-sm">
                <div>
                  <dt className="text-faint">Clinic</dt>
                  <dd className="font-medium text-ink-soft">{doctor.clinic_name}</dd>
                </div>
                <div>
                  <dt className="text-faint">Address</dt>
                  <dd className="text-ink-soft">{doctor.address}</dd>
                </div>
                <div>
                  <dt className="text-faint">City</dt>
                  <dd className="text-ink-soft">{doctor.city}</dd>
                </div>
              </dl>
            </Card>
          </section>

          <section aria-labelledby="languages-heading">
            <Card className="p-6">
              <h2 id="languages-heading" className="font-display text-base font-semibold text-ink">
                Languages
              </h2>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {doctor.languages.map((language) => (
                  <li key={language}>
                    <Badge variant="neutral">{language}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </div>
      </div>

      {/* ---- Reviews ---- */}
      <section aria-labelledby="reviews-heading" className="mt-8">
        <h2 id="reviews-heading" className="font-display text-lg font-semibold text-ink">
          Reviews
        </h2>

        {reviewsPhase === "success" && reviews && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-display text-3xl font-semibold text-ink">{doctor.rating.toFixed(1)}</span>
              <span className="flex flex-col gap-0.5">
                <Stars rating={doctor.rating} label={ratingOutOfFive(doctor.rating)} />
                <span className="text-xs text-muted">
                  {doctor.review_count} review{doctor.review_count === 1 ? "" : "s"}
                </span>
              </span>
            </div>

            {reviews.reviews.length === 0 ? (
              <p className="mt-4 text-[15px] text-muted">No reviews yet.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {reviews.reviews.map((review) => (
                  <li key={review.id} className="py-4 first:pt-0">
                    <article>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Stars rating={review.rating} label={ratingOutOfFive(review.rating)} />
                        {review.is_demo && <Badge variant="demo">Sample review</Badge>}
                      </div>
                      {review.comment && (
                        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-ink-soft">“{review.comment}”</p>
                      )}
                      <p className="mt-2 text-[13px] text-muted">
                        — {review.reviewer_name || "Anonymous"}
                        {review.verified_visit && (
                          <>
                            <span aria-hidden className="text-faint"> · </span>
                            Verified visit
                          </>
                        )}
                        {review.created_at && (
                          <>
                            <span aria-hidden className="text-faint"> · </span>
                            <time dateTime={review.created_at}>{reviewDate(review.created_at)}</time>
                          </>
                        )}
                      </p>
                    </article>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-faint">
              Reviews are user-generated sample records shown for this MVP demo — Mediqo does not write or endorse them.
            </p>
          </>
        )}

        {reviewsPhase === "loading" && <ReviewsSkeleton />}

        {reviewsPhase === "error" && (
          <ErrorState
            title="We couldn't load reviews right now."
            message="The doctor's profile is shown above; reviews are temporarily unavailable."
            onRetry={retryReviews}
            className="mt-4"
          />
        )}
      </section>
    </PageContainer>
  );
}
