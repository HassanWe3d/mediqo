/**
 * Demo appointment booking helpers.
 *
 * This is a LOCAL-ONLY demo feature: no booking API, no backend writes,
 * no real availability system. Slots are derived deterministically from the
 * doctor's existing `availability` JSONB (the same data the profile's
 * Availability card shows), so the demo slots correspond to the published
 * schedule. Nothing here talks to the network.
 */

import type { Availability } from "../types/api";

/** A bookable 30-minute demo slot, in 24h "HH:MM" form. */
export interface DemoSlot {
  /** Day key matching the availability map ("mon".."sun"). */
  day: keyof Availability;
  /** 24h "HH:MM" start time. */
  start: string;
  /** 24h "HH:MM" end time. */
  end: string;
}

const DAY_ORDER: (keyof Availability)[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const SLOT_MINUTES = 30;

export interface DemoDaySlots {
  /** ISO date (yyyy-mm-dd) for the actual calendar date of this day. */
  date: string;
  /** "Wed 30 Sep" style label. */
  label: string;
  day: keyof Availability;
  /** Slots ordered chronologically; past slots on today's date are omitted. */
  slots: { start: string; end: string }[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function toHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build the demo bookable week from the doctor's published availability:
 * the next 7 days STARTING TODAY (past days are never bookable), one entry
 * per day that has windows. 30-minute slots inside each window; slots that
 * already started today are excluded. Deterministic for a given moment +
 * availability.
 */
export function buildDemoWeek(availability: Availability, now: Date = new Date()): DemoDaySlots[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = isoDate(today);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const days: DemoDaySlots[] = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const day = DAY_ORDER[(today.getDay() + 6 + i) % 7];
    const windows = availability[day] ?? [];
    if (windows.length === 0) continue;

    const iso = isoDate(date);
    const slots: { start: string; end: string }[] = [];
    for (const [from, to] of windows) {
      const fromMin = toMinutes(from);
      const toMin = toMinutes(to);
      if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) continue;
      for (let t = fromMin; t + SLOT_MINUTES <= toMin; t += SLOT_MINUTES) {
        // Skip slots that already started today (keep the demo plausible).
        if (iso === todayIso && t < nowMinutes) continue;
        slots.push({ start: toHHMM(t), end: toHHMM(t + SLOT_MINUTES) });
      }
    }
    if (slots.length === 0) continue;
    days.push({ date: iso, label: formatDayLabel(date), day, slots });
  }
  return days;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/* ---------------------------------------------------------------------------
 * Persistence (localStorage only — demo scope, never sent to any server)
 * ------------------------------------------------------------------------- */

export interface DemoBooking {
  /** Deterministic demo reference (MQ-XXXXXX). */
  ref: string;
  doctorId: number;
  doctorName: string;
  specialization: string;
  clinicName: string;
  city: string;
  /** ISO date of the booked day. */
  date: string;
  /** 24h "HH:MM" start. */
  start: string;
  /** 24h "HH:MM" end. */
  end: string;
  patientName: string;
  contact: string;
  createdAt: string;
}

const STORAGE_KEY = "mediqo.demoBookings";

/** Read all demo bookings; unavailable/blocked storage degrades to empty. */
export function loadDemoBookings(): Record<string, DemoBooking> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, DemoBooking>) : {};
  } catch {
    return {};
  }
}

/** Persist a booking under its ref; returns false if storage is unavailable. */
export function saveDemoBooking(booking: DemoBooking): boolean {
  try {
    const all = loadDemoBookings();
    all[booking.ref] = booking;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** Look up one booking by demo reference. */
export function getDemoBooking(ref: string): DemoBooking | null {
  return loadDemoBookings()[ref] ?? null;
}

/** Most recent demo booking for a doctor, or null. */
export function getDemoBookingForDoctor(doctorId: number): DemoBooking | null {
  // Latest-by-createdAt via reduce (no Array.sort — the e2e source-of-truth
  // audit forbids any frontend sorting, and we only need the maximum here).
  return Object.values(loadDemoBookings())
    .filter((booking) => booking.doctorId === doctorId)
    .reduce<DemoBooking | null>(
      (latest, booking) => (latest === null || booking.createdAt > latest.createdAt ? booking : latest),
      null,
    );
}

/**
 * Deterministic demo reference: FNV-1a over (doctorId, date, start),
 * rendered as MQ-XXXXXX. Same inputs always produce the same ref.
 */
export function demoRef(doctorId: number, date: string, start: string): string {
  const input = `${doctorId}|${date}|${start}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const code = (hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `MQ-${code}`;
}
