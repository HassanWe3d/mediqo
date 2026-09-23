import { forwardRef } from "react";
import { Spinner } from "./Spinner";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white border border-accent hover:bg-accent-strong hover:border-accent-strong",
  secondary:
    "bg-surface text-ink border border-line-strong hover:border-ink/30 hover:bg-surface-soft/60",
  ghost: "bg-transparent text-ink-soft border border-transparent hover:bg-surface-soft",
};

const sizeClasses: Record<ButtonSize, string> = {
  md: "h-11 px-5 text-[15px]",
  lg: "h-13 px-7 text-base",
};

/**
 * The single button for the whole product. Tactile press (scale 0.985),
 * quick 160ms transitions, visible focus ring from the global stylesheet.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className = "", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-display font-medium tracking-[0.01em] transition-[background-color,border-color,box-shadow,transform] duration-[160ms] ease-out active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
});
