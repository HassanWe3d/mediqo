import type { Config } from "tailwindcss";

/**
 * MEDIQO design tokens (Tailwind v3, pure-JS pipeline — no native modules).
 * Single source of truth for color/shape/motion utilities.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#FAFAF7",
        surface: "#FFFFFF",
        "surface-soft": "#F3F3EE",
        ink: "#16211C",
        "ink-soft": "#3C4A43",
        muted: "#64716A",
        faint: "#6B7570", // WCAG AA: 4.57:1 on bg / 4.77:1 on surface (was #97A29B — 2.5:1, failed axe color-contrast)
        line: "#E6E6DE",
        "line-strong": "#D4D5CA",
        accent: {
          DEFAULT: "#0E7C66",
          strong: "#0A6252",
          soft: "#E8F3EF",
          line: "#CFE5DD",
        },
        success: "#0E7C66",
        danger: "#B0483A",
      },
      fontFamily: {
        display: ['"Sora Variable"', "Sora", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        md: "10px",
        lg: "14px",
        xl: "20px",
      },
      height: {
        // 52px — the primary-CTA height (comfortable tap target; Tailwind's
        // default scale skips 13, which silently dropped the class).
        13: "3.25rem",
      },
      boxShadow: {
        card: "0 1px 2px rgb(22 33 28 / 0.04), 0 10px 28px -14px rgb(22 33 28 / 0.14)",
        lift: "0 2px 4px rgb(22 33 28 / 0.05), 0 18px 36px -16px rgb(22 33 28 / 0.2)",
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "none" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "0.3", transform: "scale(0.8)" },
          "50%": { opacity: "1", transform: "scale(1)" },
        },
        caret: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        "radar-ping": {
          "0%": { transform: "scale(0.5)", opacity: "0.55" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
      },
      animation: {
        "fade-up": "fade-up 420ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "pulse-dot": "pulse-dot 1.1s ease-in-out infinite",
        caret: "caret 1.1s step-end infinite",
        "radar-ping": "radar-ping 2.2s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
