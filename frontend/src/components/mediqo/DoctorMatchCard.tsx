import { Link } from "react-router-dom";
import type { MatchResult } from "../../types/api";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

const NOT_AVAILABLE = "Not available today";

/**
 * The availability line is taken verbatim from the backend's own
 * match_reasons (its availability phrasing is the source of truth) —
 * never recomputed in the frontend.
 */
function availabilityChip(reasons: string[]): string | null {
  const available = reasons.find((reason) => reason.startsWith("Available"));
  if (available) return available;
  return reasons.includes(NOT_AVAILABLE) ? NOT_AVAILABLE : null;
}

export interface DoctorMatchCardProps {
  result: MatchResult;
  /** Position in the backend's ranking (0-based). The first result gets a
   *  slightly stronger visual treatment — neutral emphasis, never
   *  medical-superlative language ("best doctor" etc.). */
  rank: number;
}

export function DoctorMatchCard({ result, rank }: DoctorMatchCardProps) {
  const { doctor, distance_km, match_score, match_reasons } = result;
  const availability = availabilityChip(match_reasons);
  // The facts row already shows distance + availability verbatim; the
  // "Why this doctor" chips carry the remaining backend reasons unchanged.
  const reasonChips = match_reasons.filter(
    (reason) =>
      reason !== availability &&
      reason !== `${distance_km.toFixed(1)} km away` &&
      reason !== "Less than 1 km away",
  );

  return (
    <Card as="li" className={`p-5 sm:p-6 ${rank === 0 ? "border-accent-line" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-semibold text-ink">{doctor.name}</h3>
            {doctor.is_demo && <Badge variant="demo">Demo profile</Badge>}
          </div>
          <p className="mt-0.5 text-sm">
            <span className="font-medium text-ink-soft">{doctor.specialization}</span>
            <span aria-hidden className="text-faint"> · </span>
            <span className="text-muted">{doctor.qualification}</span>
          </p>
        </div>
        {/* data-match-score: stable test hook for QA assertions. */}
        <span data-match-score className="shrink-0">
          <Badge variant={rank === 0 ? "accent" : "neutral"}>{match_score}% match</Badge>
        </span>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-sm">
        <span className="sr-only">Rated </span>
        <span aria-hidden className="text-accent">★</span>
        <span className="font-medium text-ink">{doctor.rating.toFixed(1)}</span>
        <span aria-hidden className="text-faint">·</span>
        <span className="text-muted">{doctor.review_count} reviews</span>
      </p>

      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
        <span className="font-medium text-ink-soft">{distance_km.toFixed(1)} km away</span>
        {availability && (
          <>
            <span aria-hidden className="text-faint">·</span>
            <Badge variant="accent">{availability}</Badge>
          </>
        )}
        <span aria-hidden className="text-faint">·</span>
        <span>{doctor.experience_years} years experience</span>
        <span aria-hidden className="text-faint">·</span>
        <span>{doctor.languages.join(" · ")}</span>
      </p>

      {reasonChips.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
            Why this doctor
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {reasonChips.map((reason) => (
              <li key={reason}>
                <Badge variant="neutral">{reason}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          <span className="font-medium text-ink-soft">{doctor.clinic_name}</span>
          <span aria-hidden className="text-faint"> · </span>₹
          {doctor.consultation_fee.toLocaleString("en-IN")} consultation
        </p>
        <Link
          to={`/doctor/${doctor.id}`}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-5 font-display text-[15px] font-medium tracking-[0.01em] text-ink transition-[background-color,border-color,box-shadow,transform] duration-[160ms] ease-out hover:border-ink/30 hover:bg-surface-soft/60 active:scale-[0.985]"
        >
          View Profile
        </Link>
      </div>
    </Card>
  );
}
