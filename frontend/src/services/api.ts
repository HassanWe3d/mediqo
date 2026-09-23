/**
 * Centralized Mediqo API client.
 *
 * Every backend call goes through here — components never call fetch
 * directly. Errors are normalized into ApiError with user-friendly
 * messages; raw network/HTTP details never leak into the UI.
 */

import type {
  DoctorDetail,
  DoctorListResponse,
  DoctorReviewsResponse,
  HealthDbStatus,
  HealthStatus,
  LocationInput,
  LocationValidation,
  ManualLocation,
  MatchRequest,
  MatchResponse,
  MedicalProblemAnalysis,
  SupportedCity,
} from "../types/api";

const BASE_URL = import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "");

export type ApiErrorKind = "network" | "http" | "validation";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ApiErrorKind,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function friendlyMessage(status: number, backendDetail: string | undefined): string {
  if (status === 0 || backendDetail === undefined) {
    return "We can't reach Mediqo right now. Please check your connection and try again.";
  }
  if (status === 404) {
    return backendDetail || "We couldn't find what you were looking for.";
  }
  if (status === 422) {
    return backendDetail || "That input doesn't look right. Please review and try again.";
  }
  if (status === 503) {
    return backendDetail || "Mediqo is temporarily unavailable. Please try again shortly.";
  }
  return backendDetail || "Something went wrong. Please try again.";
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(friendlyMessage(0, undefined), 0, "network");
  }

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") {
        detail = payload.detail;
      } else if (Array.isArray(payload.detail) && payload.detail.length > 0) {
        // FastAPI validation errors: surface the first human-readable part.
        const first = payload.detail[0] as { msg?: string };
        detail = typeof first?.msg === "string" ? first.msg.replace(/^Value error,\s*/i, "") : undefined;
      }
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(friendlyMessage(response.status, detail), response.status, response.status === 422 ? "validation" : "http");
  }

  return (await response.json()) as T;
}

export const api = {
  /* Health */
  health: () => request<HealthStatus>("/health"),
  healthDb: () => request<HealthDbStatus>("/health/db"),

  /* Location (Step 6) */
  validateLocation: (input: LocationInput) =>
    request<LocationValidation>("/location/validate", { method: "POST", body: input }),
  manualLocation: (city: string) =>
    request<ManualLocation>("/location/manual", { method: "POST", body: { city } }),
  getSupportedCities: () => request<SupportedCity[]>("/location/cities"),

  /* AI analysis (Step 5) */
  analyzeProblem: (problem: string) =>
    request<MedicalProblemAnalysis>("/analyze-problem", { method: "POST", body: { problem } }),

  /* Matching (Step 7) */
  matchDoctors: (payload: MatchRequest) =>
    request<MatchResponse>("/match-doctors", { method: "POST", body: payload }),

  /* Doctors & reviews (Step 4) */
  getDoctors: (page = 1, pageSize = 10) =>
    request<DoctorListResponse>(`/doctors?page=${page}&page_size=${pageSize}`),
  getDoctor: (id: number) => request<DoctorDetail>(`/doctors/${id}`),
  getDoctorReviews: (id: number, page = 1, pageSize = 10) =>
    request<DoctorReviewsResponse>(`/doctors/${id}/reviews?page=${page}&page_size=${pageSize}`),
};
