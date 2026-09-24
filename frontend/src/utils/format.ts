/**
 * Small presentation-only formatting helpers (Step 9.6). Pure functions —
 * no state, no fetching. Every value displayed by the doctor profile comes
 * from the backend; these helpers only decide HOW it is rendered.
 */

import type { DoctorDetail } from "../types/api";

/** Doctor name → initials: first letters of the first two words (Aisha Khan → AK). */
export function doctorInitials(name: string): string {
  return name
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABELS: Record<(typeof DAY_ORDER)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** "16:00" → "4 PM" (backend gives 24h strings). */
function to12h(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = Number.parseInt(hStr, 10);
  if (!Number.isFinite(h)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mStr === "00" ? `${h12} ${suffix}` : `${h12}:${mStr} ${suffix}`;
}

/**
 * Group the JSONB schedule into rows, merging consecutive days that share
 * identical hours (Mon–Fri 4 PM–8 PM style) — quieter than one row per day.
 */
export function availabilityRows(
  availability: DoctorDetail["availability"],
): { days: string; hours: string }[] {
  const rows: { days: string; hours: string }[] = [];
  let run: { labels: string[]; hours: string } | null = null;

  for (const day of DAY_ORDER) {
    const windows = availability[day] ?? [];
    if (windows.length === 0) {
      run = null;
      continue;
    }
    const hours = windows.map(([start, end]) => `${to12h(start)}–${to12h(end)}`).join(", ");
    if (run && run.hours === hours) {
      run.labels.push(DAY_LABELS[day]);
    } else {
      if (run) rows.push({ days: mergeDayLabels(run.labels), hours: run.hours });
      run = { labels: [DAY_LABELS[day]], hours };
    }
  }
  if (run) rows.push({ days: mergeDayLabels(run.labels), hours: run.hours });
  return rows;
}

/** ["Monday","Tuesday"] → "Monday–Tuesday"; singletons stay singular. */
function mergeDayLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels[0]}–${labels[labels.length - 1]}`;
}

/** ISO timestamp → "Sep 17, 2026". Deterministic, no relative-time guessing. */
export function reviewDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A11y text for a review rating: "Rated 5 out of 5". */
export function ratingOutOfFive(rating: number): string {
  return `Rated ${rating} out of 5`;
}

/** "₹400" with Indian digit grouping — backend sends a decimal number. */
export function feeDisplay(fee: number): string {
  return `₹${fee.toLocaleString("en-IN")}`;
}

/** "14:30" → "2:30 PM" (demo booking slot labels; falls back to the input). */
export function to12hLabel(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = Number.parseInt(hStr, 10);
  if (!Number.isFinite(h)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mStr === "00" ? `${h12} ${suffix}` : `${h12}:${mStr} ${suffix}`;
}

