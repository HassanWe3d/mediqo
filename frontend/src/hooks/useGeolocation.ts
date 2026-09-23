/**
 * Browser geolocation wrapper (Step 9.3).
 *
 * The permission prompt must be a consequence of a user action, so
 * `request()` is only ever called from a click handler — never on mount.
 * Error codes map to a small closed set the page renders friendly copy
 * for; raw browser errors never surface.
 */

import { useCallback, useState } from "react";

export type GeoStatus =
  | "idle"
  | "locating"
  | "success"
  | "denied"
  | "unavailable"
  | "timeout"
  | "unsupported";

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export function useGeolocation() {
  const [status, setStatus] = useState<GeoStatus>("idle");
  const [fix, setFix] = useState<GeoFix | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unsupported");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFix({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setStatus("success");
      },
      (error) => {
        // Map by the spec's numeric codes (1 = denied, 2 = unavailable,
        // 3 = timeout) rather than the error object's named constants —
        // those live on GeolocationPositionError.prototype and are not
        // guaranteed to exist on every error implementation.
        if (error.code === 1) setStatus("denied");
        else if (error.code === 3) setStatus("timeout");
        else setStatus("unavailable");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setFix(null);
  }, []);

  return { status, fix, request, reset };
}
