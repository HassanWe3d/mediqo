import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

/**
 * Quiet landing-page entry point for the demo "Manage Appointment" flow:
 * paste an Appointment ID, jump straight to the dashboard. Deliberately
 * compact — one line of copy, one field, one button.
 */
export function ManageAppointment() {
  const navigate = useNavigate();
  const [appointmentId, setAppointmentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = appointmentId.trim();
    if (id.length === 0) {
      setError("Please enter your Appointment ID.");
      return;
    }
    navigate(`/appointments/manage?id=${encodeURIComponent(id)}`);
  };

  return (
    <section aria-labelledby="manage-appointment-heading" className="pb-16 sm:pb-20">
      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <div className="mx-auto max-w-xl rounded-xl border border-line bg-surface px-6 py-7 shadow-card">
          <h2 id="manage-appointment-heading" className="font-display text-base font-semibold text-ink">
            Manage your appointment
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Already booked in this browser? Enter your Appointment ID to view, reschedule or cancel it.
          </p>
          <form className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
            <div className="flex-1">
              <Input
                label="Appointment ID"
                value={appointmentId}
                onChange={(event) => {
                  setAppointmentId(event.target.value);
                  setError(null);
                }}
                placeholder="MQ-XXXXXX"
                error={error ?? undefined}
                autoComplete="off"
              />
            </div>
            <Button type="submit" size="md">
              View Appointment
            </Button>
          </form>
        </div>
      </div>
    </section>
  );
}
