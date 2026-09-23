import type { ReactNode } from "react";

export interface FadeRevealProps {
  children: ReactNode;
  /** Stagger delay in ms — used sparingly for hero compositions. */
  delay?: number;
  className?: string;
}

/**
 * Mount entrance: 10px rise + fade over 420ms (React Bits "Animated
 * Content", reduced to one restrained, Mediqo-flavoured motion). Global
 * reduced-motion handling makes this instant for users who opt out.
 */
export function FadeReveal({ children, delay = 0, className = "" }: FadeRevealProps) {
  return (
    <div className={`animate-fade-up ${className}`} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}
