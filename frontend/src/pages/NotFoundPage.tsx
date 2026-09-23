import { Link } from "react-router-dom";
import { PageContainer } from "../components/layout/PageContainer";
import { Button } from "../components/ui/Button";

export function NotFoundPage() {
  return (
    <PageContainer className="py-24">
      <div className="flex flex-col items-start gap-4">
        <p className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          404
        </p>
        <h1 className="text-2xl font-semibold text-ink">This page doesn't exist.</h1>
        <p className="text-[15px] text-muted">Let's get you back on track.</p>
        <Link to="/">
          <Button variant="secondary">Back to Mediqo</Button>
        </Link>
      </div>
    </PageContainer>
  );
}
