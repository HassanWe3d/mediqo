import type { ReactNode } from "react";

type BadgeVariant = "neutral" | "accent" | "demo" | "success" | "danger";

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "border-line bg-surface-soft text-muted",
  accent: "border-accent-line bg-accent-soft text-accent-strong",
  demo: "border-line bg-surface-soft text-muted",
  success: "border-accent-line bg-success-soft text-accent-strong",
  danger: "border-danger/20 bg-danger-soft text-danger",
};

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = "neutral", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-[0.02em] ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
