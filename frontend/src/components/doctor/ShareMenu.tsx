import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/Button";

/**
 * "Share" action for the doctor profile.
 *
 * The shared URL is always the ACTUAL doctor profile route built from the
 * current location (origin + /doctor/{id}) — never a doctor name and never a
 * hardcoded URL. WhatsApp goes through wa.me with an encoded message; Copy
 * Link uses the clipboard with graceful failure; native share is offered
 * only when navigator.share exists.
 */

export interface ShareMenuProps {
  doctorId: number;
  doctorName: string;
}

export function doctorShareUrl(doctorId: number): string {
  return `${window.location.origin}/doctor/${doctorId}`;
}

export function whatsappShareUrl(doctorId: number, doctorName: string): string {
  const text = `Check out ${doctorName} on Mediqo.\n${doctorShareUrl(doctorId)}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function ShareMenu({ doctorId, doctorName }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  /* Close on outside click / Escape while the menu is open. */
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copyLink = async () => {
    const url = doctorShareUrl(doctorId);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setCopied(false);
    }
  };

  const nativeShare = async () => {
    if (!canNativeShare) return;
    try {
      await navigator.share({ title: "Mediqo", text: `Check out ${doctorName} on Mediqo.`, url: doctorShareUrl(doctorId) });
      setOpen(false);
    } catch {
      /* user dismissed the share sheet — nothing to do */
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button variant="secondary" size="md" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden>⇪</span>
        Share
      </Button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Share ${doctorName}'s profile`}
          className="absolute right-0 z-40 mt-2 w-56 animate-fade-up rounded-xl border border-line bg-surface p-1.5 shadow-lift"
        >
          <a
            role="menuitem"
            href={whatsappShareUrl(doctorId, doctorName)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] text-ink transition-colors duration-[160ms] hover:bg-surface-soft"
          >
            <span aria-hidden>🟢</span> WhatsApp
          </a>
          <button
            role="menuitem"
            type="button"
            onClick={copyLink}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[15px] text-ink transition-colors duration-[160ms] hover:bg-surface-soft"
          >
            <span aria-hidden>🔗</span>
            {copied ? "Profile link copied ✓" : "Copy Link"}
          </button>
          {canNativeShare && (
            <button
              role="menuitem"
              type="button"
              onClick={nativeShare}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[15px] text-ink transition-colors duration-[160ms] hover:bg-surface-soft"
            >
              <span aria-hidden>📤</span> Share…
            </button>
          )}
          {copyFailed && (
            <p role="alert" className="px-3 pb-2 pt-1 text-xs text-danger">
              Couldn't access the clipboard — you can copy the address bar URL instead.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
