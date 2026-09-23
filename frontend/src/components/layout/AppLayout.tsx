import { Outlet } from "react-router-dom";
import { AppHeader } from "./AppHeader";
import { Wordmark } from "../mediqo/Wordmark";

export function AppLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <Wordmark />
            <p className="mt-1.5 text-xs text-muted">Find the right doctor, wherever you are.</p>
          </div>
          <div className="text-xs text-faint sm:text-right">
            <p>MVP demo · sample data · not a diagnostic service</p>
            <p className="mt-1">In an emergency, contact local emergency services.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
