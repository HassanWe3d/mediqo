import { Link } from "react-router-dom";
import { Button } from "../ui/Button";

/** Final call-to-action — same real flow, same destination as the hero. */
export function FinalCta() {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <div className="relative overflow-hidden rounded-2xl border border-line bg-surface px-6 py-14 text-center shadow-card sm:px-12">
          <div aria-hidden className="hero-grid absolute inset-0 opacity-70" />
          <div
            aria-hidden
            className="absolute left-1/2 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-soft blur-3xl"
          />
          <div className="relative">
            <h2 className="text-3xl font-semibold text-ink sm:text-4xl">
              Ready to find your doctor?
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
              Start with your location — the whole flow takes under a minute.
            </p>
            <div className="mt-8 flex justify-center">
              <Link to="/location">
                <Button size="lg">Find a Doctor</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
