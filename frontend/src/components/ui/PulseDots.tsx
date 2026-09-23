export interface PulseDotsProps {
  label?: string;
  className?: string;
}

/**
 * Minimal three-dot loader (adapted from UIverse loader patterns).
 * Used while Mediqo "thinks" — calm, not busy.
 */
export function PulseDots({ label = "Loading", className = "" }: PulseDotsProps) {
  return (
    <span role="status" aria-label={label} className={`inline-flex items-center gap-1.5 ${className}`}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden
          className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-accent"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </span>
  );
}
