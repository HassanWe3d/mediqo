import { Badge } from "../ui/Badge";
import { SectionHeading } from "../ui/SectionHeading";

function ArrowRight({ className = "" }: { className?: string }) {
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
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/**
 * The product's key differentiator: users never pick a specialty —
 * Mediqo's analysis does. Includes a small mechanism demo (design only).
 */
export function Differentiator() {
  return (
    <section
      id="why-mediqo"
      className="scroll-mt-20 border-b border-line bg-surface-soft/60 py-16 sm:py-24"
    >
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="Why Mediqo"
          title="You don't need to know which specialist you need."
        />
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          Most people can&rsquo;t tell one specialist from another — and
          shouldn&rsquo;t have to. Describe what&rsquo;s wrong in your own words;
          Mediqo identifies the relevant specialty and matches you with suitable
          doctors nearby.
        </p>

        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          <p className="font-display text-lg font-medium text-ink">You describe the problem.</p>
          <ArrowRight className="h-4 w-4 rotate-90 text-accent sm:rotate-0" />
          <p className="font-display text-lg font-medium text-accent">
            Mediqo finds the specialty.
          </p>
          <ArrowRight className="h-4 w-4 rotate-90 text-accent sm:rotate-0" />
          <p className="font-display text-lg font-medium text-ink">You meet nearby doctors.</p>
        </div>

        <div className="mt-10 max-w-2xl rounded-xl border border-line bg-surface p-5 shadow-card">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
            What happens under the hood
          </p>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex-1 rounded-md border border-line bg-surface-soft/70 px-4 py-3 text-[15px] italic text-ink-soft">
              &ldquo;I&rsquo;ve had stomach pain since yesterday&rdquo;
            </div>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <ArrowRight className="h-4 w-4" />
            </span>
            <div className="flex items-center gap-3">
              <Badge variant="accent">Gastroenterologist</Badge>
              <span className="text-xs text-faint">identified by Mediqo</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
