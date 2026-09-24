import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { buildDemoWeek, demoRef, saveDemoBooking, type DemoBooking, type DemoDaySlots } from "../../utils/bookingSlots";
import { feeDisplay, to12hLabel } from "../../utils/format";

/**
 * Demo appointment booking modal — LOCAL-ONLY demo, never a real booking.
 * Slot availability is derived from the doctor's published availability (the
 * same data as the profile's Availability card); the confirmed booking is
 * stored only in this browser's localStorage.
 */

export interface BookingModalProps {
  doctor: {
    id: number;
    name: string;
    specialization: string;
    clinic_name: string;
    city: string;
    consultation_fee: number;
  };
  availability: Parameters<typeof buildDemoWeek>[0];
  onClose: () => void;
  onBooked: (booking: DemoBooking) => void;
}

type Step = "form" | "confirmation";

function weekOf(availability: Parameters<typeof buildDemoWeek>[0], now: Date): DemoDaySlots[] {
  return buildDemoWeek(availability, now);
}

export function BookingModal({ doctor, availability, onClose, onBooked }: BookingModalProps) {
  const [step, setStep] = useState<Step>("form");
  const [week] = useState<DemoDaySlots[]>(() => weekOf(availability, new Date()));
  const [dayIndex, setDayIndex] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null);
  const [patientName, setPatientName] = useState("");
  const [contact, setContact] = useState("");
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const [booking, setBooking] = useState<DemoBooking | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const day = week[dayIndex] ?? null;
  const nameError = touched && patientName.trim().length === 0 ? "Please enter the patient's name." : null;
  const showSlotError = touched && !selectedSlot;

  /* Lock body scroll while open; Escape closes. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /* Minimal focus trap: focus the first element and keep Tab inside the dialog. */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      } else if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, []);

  const attemptConfirm = () => {
    setTouched(true);
    if (!day || patientName.trim().length === 0 || !selectedSlot) return;
    const ref = demoRef(doctor.id, day.date, selectedSlot.start);
    const record: DemoBooking = {
      ref,
      doctorId: doctor.id,
      doctorName: doctor.name,
      specialization: doctor.specialization,
      clinicName: doctor.clinic_name,
      city: doctor.city,
      date: day.date,
      start: selectedSlot.start,
      end: selectedSlot.end,
      patientName: patientName.trim(),
      contact: contact.trim(),
      createdAt: new Date().toISOString(),
    };
    saveDemoBooking(record);
    setBooking(record);
    setStep("confirmation");
    onBooked(record);
  };

  const copyDetails = async () => {
    if (!booking) return;
    const text =
      `Mediqo demo appointment ${booking.ref} — ${booking.doctorName} (${booking.specialization}), ` +
      `${booking.date} ${booking.start}–${booking.end}, ${booking.clinicName}, ${booking.city}. ` +
      `This is a demo confirmation, not a real booking.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the demo record is still saved locally */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92dvh] w-full max-w-lg animate-fade-up overflow-y-auto rounded-t-xl border border-line bg-surface shadow-lift sm:rounded-xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4 sm:px-6">
          <div>
            <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
              {step === "form" ? "Book Appointment" : "Appointment Booked"}
            </h2>
            <p className="text-xs text-muted">
              {step === "form" ? "Demo only — no real booking is made." : "Demo confirmation — not a real booking."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close booking dialog"
            className="-mr-1 rounded-md p-1.5 text-muted transition-colors duration-[160ms] hover:bg-surface-soft hover:text-ink"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>

        {step === "form" ? (
          <div className="space-y-5 px-5 py-5 sm:px-6">
            {/* Doctor summary */}
            <Card className="p-4">
              <p className="font-display text-base font-semibold text-ink">{doctor.name}</p>
              <p className="mt-0.5 text-sm text-muted">
                {doctor.specialization} · {doctor.clinic_name} · {doctor.city}
              </p>
              <p className="mt-1 text-sm font-medium text-ink-soft">
                {feeDisplay(doctor.consultation_fee)} per consultation
              </p>
            </Card>

            {/* 1 · Date selection */}
            <section aria-label="Select a date">
              <p className="text-[13px] font-medium text-ink-soft">1 · Select a date</p>
              {week.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No published availability this week.</p>
              ) : (
                <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                  {week.map((d, i) => {
                    const active = i === dayIndex;
                    return (
                      <button
                        key={d.date}
                        type="button"
                        onClick={() => {
                          setDayIndex(i);
                          setSelectedSlot(null);
                        }}
                        aria-pressed={active}
                        className={`shrink-0 rounded-lg border px-3.5 py-2 text-sm font-medium transition-[background-color,border-color] duration-[160ms] ${
                          active
                            ? "border-accent bg-accent-soft text-accent-strong"
                            : "border-line bg-surface text-ink-soft hover:border-line-strong"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 2 · Time selection */}
            <section aria-label="Select a time">
              <p className="text-[13px] font-medium text-ink-soft">2 · Select an available time</p>
              {day && day.slots.length > 0 ? (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {day.slots.map((slot) => {
                    const active = selectedSlot?.start === slot.start;
                    return (
                      <button
                        key={slot.start}
                        type="button"
                        onClick={() => setSelectedSlot(slot)}
                        aria-pressed={active}
                        className={`rounded-md border px-2 py-2 text-[13px] font-medium transition-[background-color,border-color] duration-[160ms] ${
                          active
                            ? "border-accent bg-accent-soft text-accent-strong"
                            : "border-line bg-surface text-ink-soft hover:border-line-strong"
                        }`}
                      >
                        {to12hLabel(slot.start)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">No slots left this day — try another date.</p>
              )}
              {showSlotError && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  Please select an available time slot.
                </p>
              )}
            </section>

            {/* 3 · Patient details */}
            <section aria-label="Patient details">
              <p className="text-[13px] font-medium text-ink-soft">3 · Patient details</p>
              <div className="mt-2 space-y-3">
                <Input
                  label="Patient name"
                  value={patientName}
                  onChange={(event) => setPatientName(event.target.value)}
                  placeholder="e.g. Aarav Gupta"
                  error={nameError ?? undefined}
                  autoComplete="off"
                />
                <Input
                  label="Contact (optional)"
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder="Phone or email"
                  hint="Stored only in this browser for this demo."
                  autoComplete="off"
                />
              </div>
            </section>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="md" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" size="md" onClick={attemptConfirm}>
                Confirm Appointment
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 px-5 py-6 sm:px-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <span
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft font-display text-xl text-accent-strong"
              >
                ✓
              </span>
              <p className="font-display text-xl font-semibold text-ink">Appointment Booked</p>
              {booking && <Badge variant="demo">Demo reference: {booking.ref}</Badge>}
            </div>

            {booking && (
              <Card className="p-2">
                <dl className="divide-y divide-line">
                  <Row label="Doctor" value={booking.doctorName} />
                  <Row label="Specialty" value={booking.specialization} />
                  <Row label="Date" value={booking.date} />
                  <Row label="Time" value={`${to12hLabel(booking.start)} – ${to12hLabel(booking.end)}`} />
                  <Row label="Location" value={`${booking.clinicName}, ${booking.city}`} />
                  <Row label="Patient" value={booking.patientName} />
                </dl>
              </Card>
            )}

            <p className="rounded-lg border border-line bg-surface-soft px-4 py-3 text-xs leading-relaxed text-muted">
              This is a demo appointment confirmation and does not represent a real booking. It is stored only in this
              browser.
            </p>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" size="md" onClick={copyDetails}>
                {copied ? "Copied ✓" : "Copy details"}
              </Button>
              <Button variant="primary" size="md" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}
