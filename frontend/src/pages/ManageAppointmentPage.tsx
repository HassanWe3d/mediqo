import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../services/api";
import type { DoctorDetail } from "../types/api";
import {
  buildDemoWeek,
  cancelDemoBooking,
  findDemoBooking,
  rescheduleDemoBooking,
  type DemoBooking,
  type DemoBookingStatus,
} from "../utils/bookingSlots";
import { to12hLabel } from "../utils/format";
import { PageContainer } from "../components/layout/PageContainer";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";

/**
 * Manage Appointment (demo) — look up a locally stored demo appointment by
 * its Appointment ID and reschedule or cancel it. Same demo scope as the
 * booking flow: everything lives in this browser's localStorage, nothing is
 * sent to any server, and the ID is NOT authentication — it is simply the
 * key under which the demo record is stored.
 */

type ViewMode = "lookup" | "view" | "reschedule" | "cancel-confirm";

const STATUS_META: Record<DemoBookingStatus, { label: string; variant: "success" | "accent" | "danger" }> = {
  confirmed: { label: "Confirmed", variant: "success" },
  rescheduled: { label: "Rescheduled", variant: "accent" },
  cancelled: { label: "Cancelled", variant: "danger" },
};

/** "2026-09-26" → "26 September 2026". */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function ManageAppointmentPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("id") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<DemoBooking | null>(null);
  const [mode, setMode] = useState<ViewMode>("lookup");
  const [notice, setNotice] = useState<string | null>(null);

  const [doctor, setDoctor] = useState<DoctorDetail | null>(null);
  const [doctorError, setDoctorError] = useState(false);
  const [doctorAttempt, setDoctorAttempt] = useState(0);

  const [rescheduleDay, setRescheduleDay] = useState(0);
  const [rescheduleSlot, setRescheduleSlot] = useState<{ start: string; end: string } | null>(null);

  const openBooking = useCallback(
    (record: DemoBooking, { updateUrl = true } = {}) => {
      setBooking(record);
      setMode("view");
      setError(null);
      setNotice(null);
      setRescheduleDay(0);
      setRescheduleSlot(null);
      if (updateUrl) setSearchParams({ id: record.ref });
    },
    [setSearchParams],
  );

  const lookup = (rawId?: string) => {
    const candidate = rawId ?? query;
    const record = findDemoBooking(candidate);
    if (!record) {
      setError("Appointment not found. Please check your Appointment ID.");
      setBooking(null);
      setMode("lookup");
      return;
    }
    openBooking(record, { updateUrl: rawId !== undefined });
  };

  /* Direct access: /appointments/manage?id=MQ-XXXXXX opens the dashboard. */
  useEffect(() => {
    const id = searchParams.get("id");
    if (!id) return;
    const record = findDemoBooking(id);
    if (record) {
      openBooking(record, { updateUrl: false });
    } else {
      setError("Appointment not found. Please check your Appointment ID.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per id change
  }, [searchParams]);

  /* Availability for rescheduling comes from the doctor's live profile. */
  useEffect(() => {
    if (mode !== "reschedule" || !booking) return;
    let cancelled = false;
    setDoctorError(false);
    api
      .getDoctor(booking.doctorId)
      .then((detail) => {
        if (!cancelled) setDoctor(detail);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDoctorError(!(err instanceof ApiError && err.status === 404));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, booking, doctorAttempt]);

  const week = doctor && mode === "reschedule" ? buildDemoWeek(doctor.availability) : [];
  const rescheduleDayData = week[rescheduleDay] ?? null;

  const confirmReschedule = () => {
    if (!booking || !rescheduleDayData || !rescheduleSlot) return;
    const updated = rescheduleDemoBooking(booking.ref, rescheduleDayData.date, rescheduleSlot.start, rescheduleSlot.end);
    if (!updated) {
      setError("We couldn't save the change in this browser. Please try again.");
      return;
    }
    setBooking(updated);
    setMode("view");
    setNotice("Appointment rescheduled.");
  };

  const confirmCancel = () => {
    if (!booking) return;
    const updated = cancelDemoBooking(booking.ref);
    if (!updated) {
      setError("We couldn't save the change in this browser. Please try again.");
      return;
    }
    setBooking(updated);
    setMode("view");
    setNotice("Appointment cancelled.");
  };

  const backToSearch = () => {
    setBooking(null);
    setMode("lookup");
    setError(null);
    setNotice(null);
    setSearchParams({});
  };

  /* --------------------------------------------------------------------- */
  return (
    <PageContainer className="pb-24 pt-10">
      {mode !== "lookup" ? (
        <button
          type="button"
          onClick={backToSearch}
          className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink"
        >
          <span aria-hidden>←</span> Manage another appointment
        </button>
      ) : (
        <Link to="/" className="inline-flex items-center gap-1.5 py-2 text-sm text-muted transition-colors hover:text-ink">
          <span aria-hidden>←</span> Back to Mediqo
        </Link>
      )}

      <h1 className="mt-4 text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-3xl">Manage your appointment</h1>
      <p className="mt-1.5 max-w-prose text-[15px] text-muted">
        Enter the Appointment ID from your demo booking confirmation. Demo appointments live only in this browser.
      </p>

      {mode === "lookup" && (
        <Card className="mt-6 max-w-xl p-6">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim().length === 0) {
                setError("Please enter your Appointment ID.");
                return;
              }
              lookup();
            }}
          >
            <div className="flex-1">
              <Input
                label="Appointment ID"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setError(null);
                }}
                placeholder="MQ-XXXXXX"
                error={error ?? undefined}
                autoComplete="off"
              />
            </div>
            <Button type="submit" size="md" className="sm:mb-0">
              View Appointment
            </Button>
          </form>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </Card>
      )}

      {mode !== "lookup" && booking && (
        <Card className="mt-6 max-w-xl p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold text-ink">Appointment Details</h2>
            <Badge variant="demo">{booking.ref}</Badge>
          </div>

          <dl className="mt-5 divide-y divide-line">
            <Row label="Doctor" value={booking.doctorName} />
            <Row label="Specialty" value={booking.specialization} />
            <Row label="Location" value={`${booking.clinicName}, ${booking.city}`} />
            <Row label="Patient" value={booking.patientName} />
            <Row label="Date" value={longDate(booking.date)} />
            <Row label="Time" value={`${to12hLabel(booking.start)} – ${to12hLabel(booking.end)}`} />
          </dl>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <p className="text-[13px] font-medium text-muted">Status</p>
            <Badge variant={STATUS_META[booking.status].variant}>{STATUS_META[booking.status].label}</Badge>
          </div>

          {notice && (
            <p role="status" className="mt-4 rounded-lg border border-accent-line bg-accent-soft px-4 py-3 text-sm text-accent-strong">
              {notice}
            </p>
          )}

          {booking.status === "cancelled" ? (
            <p className="mt-5 rounded-lg border border-line bg-surface-soft px-4 py-3 text-sm text-muted">
              This appointment is cancelled. The record is kept so the Appointment ID still works — book a new
              appointment from the doctor's profile if you need another slot.
            </p>
          ) : mode === "view" ? (
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" size="md" onClick={() => setMode("reschedule")}>
                Reschedule Appointment
              </Button>
              <Button variant="ghost" size="md" className="text-danger" onClick={() => setMode("cancel-confirm")}>
                Cancel Appointment
              </Button>
            </div>
          ) : mode === "cancel-confirm" ? (
            <div className="mt-6 rounded-lg border border-danger/20 bg-danger-soft/60 p-4">
              <p className="text-sm font-medium text-ink">Are you sure you want to cancel this appointment?</p>
              <p className="mt-1 text-xs text-muted">The appointment is kept on record with status Cancelled.</p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" size="md" onClick={() => setMode("view")}>
                  Keep Appointment
                </Button>
                <Button variant="primary" size="md" onClick={confirmCancel}>
                  Yes, cancel it
                </Button>
              </div>
            </div>
          ) : (
            /* ---- Reschedule ---- */
            <div className="mt-6 border-t border-line pt-5">
              <p className="text-[13px] font-medium text-ink-soft">
                Current: <span className="text-muted">{longDate(booking.date)} · {to12hLabel(booking.start)}</span>
              </p>
              {doctorError ? (
                <div className="mt-3">
                  <p className="text-sm text-danger">We couldn't load this doctor's availability.</p>
                  <Button variant="secondary" size="md" className="mt-3" onClick={() => setDoctorAttempt((a) => a + 1)}>
                    Try again
                  </Button>
                </div>
              ) : doctor === null ? (
                <p className="mt-3 text-sm text-muted">Loading availability…</p>
              ) : week.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No published availability this week — try again later.</p>
              ) : (
                <>
                  <section aria-label="Reschedule: pick a new date">
                  <p className="mt-4 text-[13px] font-medium text-ink-soft">1 · Pick a new date</p>
                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                    {week.map((d, i) => {
                      const active = i === rescheduleDay;
                      return (
                        <button
                          key={d.date}
                          type="button"
                          onClick={() => {
                            setRescheduleDay(i);
                            setRescheduleSlot(null);
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
                  </section>

                  <section aria-label="Reschedule: pick a new time">
                  <p className="mt-4 text-[13px] font-medium text-ink-soft">2 · Pick a new time</p>
                  {rescheduleDayData && rescheduleDayData.slots.length > 0 ? (
                    <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {rescheduleDayData.slots.map((slot) => {
                        const active = rescheduleSlot?.start === slot.start;
                        return (
                          <button
                            key={slot.start}
                            type="button"
                            onClick={() => setRescheduleSlot(slot)}
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
                  </section>

                  <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <Button variant="ghost" size="md" onClick={() => setMode("view")}>
                      Back
                    </Button>
                    <Button variant="primary" size="md" onClick={confirmReschedule} disabled={!rescheduleSlot}>
                      Confirm Reschedule
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          <p className="mt-6 text-xs text-faint">
            Demo appointment — stored only in this browser. Status changes are local and do not notify the doctor.
          </p>
        </Card>
      )}
    </PageContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}
