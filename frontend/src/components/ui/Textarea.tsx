import { forwardRef, useId, useEffect, useRef } from "react";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
  /** When provided with `value`, renders a live "n / max" counter. */
  maxLength?: number;
  value?: string;
}

/**
 * The product's single textarea: generous typing area, label + error wiring
 * for assistive tech, and a quiet character counter (restrained: it stays
 * visually secondary until the limit approaches).
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, maxLength, value, className = "", ...rest },
  ref,
) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const remaining = maxLength !== undefined && value !== undefined ? maxLength - value.length : null;
  const nearLimit = remaining !== null && remaining <= Math.max(20, Math.round(maxLength! * 0.1));
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  /*
   * Self-healing controlled value. Some environments (history restoration,
   * extension autofill) can rewrite the DOM value AFTER React's mount
   * commit without emitting an input event, leaving the element visibly
   * empty while React's state (and this counter) still hold the text.
   * When the DOM diverges from the controlled value, reconcile it.
   */
  useEffect(() => {
    const node = innerRef.current;
    if (node && value !== undefined && node.value !== value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(node, value);
    }
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-[13px] font-medium text-ink-soft">
          {label}
        </label>
        {remaining !== null && (
          <span
            aria-live="off"
            className={`text-xs tabular-nums ${nearLimit ? "text-danger" : "text-faint"}`}
          >
            {remaining} left
            {remaining !== null && remaining < 0 ? " — too long" : ""}
          </span>
        )}
      </div>
      <textarea
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        id={id}
        rows={5}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full resize-y rounded-md border bg-surface px-3.5 py-3 text-[15px] leading-relaxed text-ink transition-colors duration-[160ms] placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/10 ${
          error ? "border-danger" : "border-line"
        } ${className}`}
        {...rest}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
