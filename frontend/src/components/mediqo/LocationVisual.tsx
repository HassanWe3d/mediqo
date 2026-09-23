import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

export interface LocationVisualProps {
  tone?: "idle" | "seeking" | "found";
  className?: string;
}

/**
 * Map-inspired location visual (Step 9.3): a fine cartographic grid,
 * concentric range rings, crosshair ticks and a single accent pin — the
 * "where are you?" idea without a literal map or clichéd illustrations.
 * Pure CSS/SVG; one subtle radar ring only while seeking (disabled by
 * prefers-reduced-motion). Entirely decorative.
 */
export function LocationVisual({ tone = "idle", className = "" }: LocationVisualProps) {
  const reduced = usePrefersReducedMotion();
  const seeking = tone === "seeking" && !reduced;

  return (
    <div
      aria-hidden
      className={`relative aspect-[16/10] overflow-hidden rounded-xl border border-line bg-surface shadow-card ${className}`}
    >
      <div className="location-grid absolute inset-0" />

      {/* Soft accent glow behind the pin */}
      <div className="absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.06] blur-2xl" />

      <svg viewBox="0 0 640 400" className="absolute inset-0 h-full w-full">
        {/* Crosshairs */}
        <line x1="0" y1="200" x2="640" y2="200" stroke="currentColor" className="text-line" strokeDasharray="2 6" />
        <line x1="320" y1="0" x2="320" y2="400" stroke="currentColor" className="text-line" strokeDasharray="2 6" />
        {/* Range rings */}
        {[64, 128, 200].map((radius) => (
          <circle
            key={radius}
            cx="320"
            cy="200"
            r={radius}
            fill="none"
            stroke="currentColor"
            className="text-line-strong"
            strokeWidth="1"
          />
        ))}
        {/* Coordinate ticks along the crosshairs */}
        {[-140, -120, 120, 140].map((offset) => (
          <line key={`h${offset}`} x1={320 + offset} y1="196" x2={320 + offset} y2="204" stroke="currentColor" className="text-line-strong" strokeWidth="1" />
        ))}
        {[-140, -120, 120, 140].map((offset) => (
          <line key={`v${offset}`} x1="316" y1={200 + offset} x2="324" y2={200 + offset} stroke="currentColor" className="text-line-strong" strokeWidth="1" />
        ))}
      </svg>

      {/* The pin */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-full border border-accent-line bg-surface shadow-card">
          {seeking && <span className="animate-radar-ping absolute inset-0 rounded-full border-2 border-accent" />}
          <span className={`h-3 w-3 rounded-full ${tone === "found" ? "bg-accent" : "bg-accent/80"}`} />
          {tone === "found" && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-semibold leading-none text-white">
              ✓
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
