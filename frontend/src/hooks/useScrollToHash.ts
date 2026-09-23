import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * React Router doesn't scroll to #hash targets on navigation. This makes
 * header links like "How it works" land on the right section — whether the
 * user is already on the landing page or navigating home from another route.
 */
export function useScrollToHash() {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const id = hash.slice(1);
    // Wait a frame so freshly mounted sections exist before scrolling.
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
  }, [hash]);
}
