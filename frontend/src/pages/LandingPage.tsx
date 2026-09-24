import { Hero } from "../components/landing/Hero";
import { FlowSteps } from "../components/landing/FlowSteps";
import { Differentiator } from "../components/landing/Differentiator";
import { FinalCta } from "../components/landing/FinalCta";
import { ManageAppointment } from "../components/landing/ManageAppointment";
import { useScrollToHash } from "../hooks/useScrollToHash";

/**
 * The Mediqo landing experience: promise → how it works → why it's
 * different → one way forward. Everything below the hero is static,
 * honest, and decoration-free.
 */
export function LandingPage() {
  useScrollToHash();
  return (
    <>
      <Hero />
      <FlowSteps />
      <Differentiator />
      <ManageAppointment />
      <FinalCta />
    </>
  );
}
