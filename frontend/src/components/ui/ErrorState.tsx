import { Button } from "./Button";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

/** Calm, honest error presentation — never raw exceptions. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className = "",
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-card ${className}`}
    >
      <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="max-w-sm text-[15px] leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="md" onClick={onRetry} className="mt-1">
          Try again
        </Button>
      )}
    </div>
  );
}
