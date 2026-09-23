import { Link } from "react-router-dom";
import { FadeReveal } from "../mediqo/FadeReveal";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { HeroVisual } from "./HeroVisual";

/**
 * Landing hero. Left: the promise. Right: the product told visually.
 * Backdrop is a fine cartographic grid + one soft accent glow — both CSS-only.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div aria-hidden className="hero-grid absolute inset-0" />
      <div
        aria-hidden
        className="absolute -top-40 right-[-12%] h-[440px] w-[440px] rounded-full bg-accent-soft opacity-70 blur-3xl"
      />

      <div className="relative mx-auto grid w-full max-w-5xl gap-14 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-12 lg:pb-24 lg:pt-24">
        <div className="flex flex-col items-start gap-6">
          <FadeReveal>
            <Badge variant="accent">MVP preview — demo data</Badge>
          </FadeReveal>

          <FadeReveal delay={80}>
            <h1 className="text-[2.5rem] font-semibold leading-[1.06] text-ink sm:text-5xl lg:text-[3.4rem]">
              Find the{" "}
              <span className="relative inline-block whitespace-nowrap">
                right doctor
                <svg
                  aria-hidden
                  viewBox="0 0 200 9"
                  preserveAspectRatio="none"
                  className="absolute -bottom-1.5 left-0 h-2 w-full text-accent"
                >
                  <path
                    d="M2 6.5 C 50 1.5, 150 1.5, 198 5.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              ,<br className="hidden md:block" /> wherever you are.
            </h1>
          </FadeReveal>

          <FadeReveal delay={160}>
            <p className="max-w-md text-[16px] leading-relaxed text-muted">
              Tell us where you are and what you&rsquo;re experiencing. Mediqo
              understands your problem in plain words and finds suitable doctors
              nearby — no medical jargon required.
            </p>
          </FadeReveal>

          <FadeReveal delay={240}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link to="/location">
                <Button size="lg">Find a Doctor</Button>
              </Link>
              <a
                href="#how-it-works"
                className="group inline-flex items-center gap-1.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:text-accent"
              >
                See how it works
                <span aria-hidden className="transition-transform duration-[160ms] group-hover:translate-y-0.5">
                  ↓
                </span>
              </a>
            </div>
          </FadeReveal>

          <FadeReveal delay={320}>
            <p className="text-xs text-faint">
              Every doctor in this demo is clearly labelled as sample data.
            </p>
          </FadeReveal>
        </div>

        <FadeReveal delay={200} className="min-w-0">
          <HeroVisual />
        </FadeReveal>
      </div>
    </section>
  );
}
