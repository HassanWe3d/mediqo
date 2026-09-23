import { PulseDots } from "../ui/PulseDots";

/**
 * The real matching pipeline, narrated. Each stage corresponds to work the
 * backend genuinely performs (AI analysis → specialty query → distance →
 * availability → weighted scoring). The list only advances while the request
 * is in flight — no artificial delay is added, and reduced-motion users get
 * a calm static list.
 */
export const MATCHING_STAGES = [
  "Understanding your request",
  "Finding relevant specialists",
  "Checking nearby doctors",
  "Comparing availability",
  "Preparing recommendations",
] as const;

export interface MatchingProgressProps {
  /** Index of the active stage (0-based); earlier stages show as done. */
  stage: number;
}

export function MatchingProgress({ stage }: MatchingProgressProps) {
  return (
    <div aria-live="polite" aria-busy="true" className="flex flex-col items-center gap-7 py-9">
      <PulseDots className="text-accent" />
      <ol className="w-full max-w-xs space-y-3">
        {MATCHING_STAGES.map((label, index) => {
          const state = index < stage ? "done" : index === stage ? "active" : "todo";
          return (
            <li key={label} className="flex items-center gap-3">
              {state === "done" ? (
                <span
                  aria-hidden
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-strong"
                >
                  ✓
                </span>
              ) : state === "active" ? (
                <span
                  aria-hidden
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-accent"
                >
                  <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />
                </span>
              ) : (
                <span aria-hidden className="h-5 w-5 shrink-0 rounded-full border border-line" />
              )}
              <span
                className={`text-sm ${
                  state === "active"
                    ? "font-medium text-ink"
                    : state === "done"
                      ? "text-muted"
                      : "text-faint"
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
