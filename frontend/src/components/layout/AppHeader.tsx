import { Link } from "react-router-dom";
import { Wordmark } from "../mediqo/Wordmark";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

/**
 * Minimal navigation: wordmark, two in-page anchors, one real CTA.
 * Text links collapse on small screens — the CTA stays tappable.
 */
export function AppHeader() {
  return (
    <header className="border-b border-line bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
        <Wordmark />
        <nav aria-label="Primary" className="hidden items-center gap-7 text-sm text-ink-soft sm:flex">
          <Link to="/#how-it-works" className="inline-flex items-center py-2 transition-colors hover:text-ink">
            How it works
          </Link>
          <Link to="/#why-mediqo" className="inline-flex items-center py-2 transition-colors hover:text-ink">
            About
          </Link>
          <Link to="/appointments/manage" className="inline-flex items-center py-2 transition-colors hover:text-ink">
            Manage appointment
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Badge variant="demo" className="hidden md:inline-flex">
            Demo build — sample data
          </Badge>
          <Link to="/location">
            <Button size="md">Find a doctor</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
