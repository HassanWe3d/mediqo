import { SectionHeading } from "../ui/SectionHeading";

const STEPS = [
  {
    n: "01",
    title: "Tell us what you're experiencing",
    desc: "Describe it in your own words — no medical terminology required.",
  },
  {
    n: "02",
    title: "Share your location",
    desc: "Browser location or a quick city pick. Coordinates stay in your session.",
  },
  {
    n: "03",
    title: "Discover suitable doctors nearby",
    desc: "Mediqo weighs specialty, distance, availability, language and rating.",
  },
  {
    n: "04",
    title: "Choose a doctor",
    desc: "Open a profile, see exactly why it was recommended, and read sample reviews.",
  },
] as const;

/**
 * Editorial four-step flow: numbered columns sharing one top rule —
 * deliberately not a card grid.
 */
export function FlowSteps() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-b border-line py-16 sm:py-24">
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <SectionHeading
          eyebrow="How it works"
          title="From problem to doctor in four steps"
          description="No forms, no account, no medical vocabulary — the whole flow takes under a minute."
        />
        <ol className="mt-12 grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <li key={step.n} className="border-t border-line pt-5">
              <span className="font-display text-[13px] font-medium tracking-[0.08em] text-accent">
                {step.n}
              </span>
              <h3 className="mt-2 text-[17px] font-semibold text-ink">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.desc}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
