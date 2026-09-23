import { Badge } from "../ui/Badge";
import { PulseDots } from "../ui/PulseDots";

function PinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M12 21s-6.5-5.2-6.5-10.2A6.5 6.5 0 0 1 12 4.2a6.5 6.5 0 0 1 6.5 6.6C18.5 15.8 12 21 12 21Z" />
      <circle cx="12" cy="10.7" r="2.3" />
    </svg>
  );
}

function CardShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`w-fit max-w-full rounded-xl border border-line bg-surface px-5 py-4 shadow-card ${className}`}
    >
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">{children}</p>
  );
}

function Connector() {
  return (
    <div aria-hidden className="ml-10 flex h-7 items-center">
      <span className="h-full w-px border-l border-dashed border-line-strong" />
      <span className="-ml-[3px] h-1.5 w-1.5 rounded-full bg-accent" />
    </div>
  );
}

/**
 * Hero composition, right side: the Mediqo flow told in three miniature
 * cards — location → problem → discovery. A design demonstration only;
 * no fake doctors, no invented statistics.
 */
export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:max-w-none">
      <div
        aria-hidden
        className="absolute -inset-6 -z-10 rounded-3xl bg-accent-soft/60 blur-2xl"
      />
      <div className="flex flex-col">
        <CardShell>
          <Label>Where are you?</Label>
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent">
              <PinIcon className="h-4 w-4" />
            </span>
            <span className="text-[15px] font-medium text-ink">Location detected</span>
            <span aria-hidden className="relative ml-3 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          </div>
        </CardShell>

        <Connector />

        <CardShell className="ml-4 sm:ml-8">
          <Label>What are you experiencing?</Label>
          <p className="mt-2.5 max-w-[24rem] text-[15px] italic leading-relaxed text-ink-soft">
            &ldquo;I&rsquo;ve had stomach pain since yesterday&hellip;&rdquo;
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-caret bg-accent"
            />
          </p>
        </CardShell>

        <Connector />

        <CardShell className="sm:mr-6">
          <Label>Mediqo finds</Label>
          <div className="mt-2.5 flex items-center gap-2.5">
            <PulseDots label="Finding suitable doctors" />
            <span className="text-[15px] font-medium text-ink">Suitable doctors nearby</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge variant="accent">Specialty identified</Badge>
            <Badge variant="neutral">Distance ranked</Badge>
            <Badge variant="neutral">Availability checked</Badge>
          </div>
        </CardShell>
      </div>
    </div>
  );
}
