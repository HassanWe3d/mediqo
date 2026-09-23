import type { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Subtle lift on hover — use only for genuinely interactive cards. */
  interactive?: boolean;
  as?: "div" | "article" | "li";
}

export function Card({ children, className = "", interactive = false, as = "div" }: CardProps) {
  const Tag = as;
  return (
    <Tag
      className={`rounded-xl border border-line bg-surface shadow-card transition-[box-shadow,border-color,transform] duration-[160ms] ease-out ${
        interactive
          ? "cursor-pointer hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lift"
          : ""
      } ${className}`}
    >
      {children}
    </Tag>
  );
}
