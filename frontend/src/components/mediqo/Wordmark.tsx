import { Link } from "react-router-dom";

export interface WordmarkProps {
  /** Render as a link to the landing page (default true). */
  to?: string | null;
  className?: string;
}

/**
 * Typography-first brand: letterspaced Sora with a single viridian period.
 * No crosses, no hearts, no stethoscopes.
 */
export function Wordmark({ to = "/", className = "" }: WordmarkProps) {
  const content = (
    <span
      className={`font-display text-[17px] font-semibold tracking-[0.24em] text-ink select-none ${className}`}
    >
      MEDIQO<span className="text-accent">.</span>
    </span>
  );
  if (to === null) return content;
  return (
    <Link to={to} aria-label="Mediqo home" className="inline-flex items-center">
      {content}
    </Link>
  );
}
