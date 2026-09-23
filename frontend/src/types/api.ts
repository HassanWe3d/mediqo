/**
 * Mediqo API types — mirror the backend Pydantic schemas 1:1.
 * Do not invent fields; these are the verified Step 2–8 contracts.
 */

export type Urgency = "normal" | "urgent" | "emergency";

export type MatchStatus = "success" | "emergency" | "no_match";

export const SUPPORTED_SPECIALIZATIONS = [
  "General Physician",
  "Cardiologist",
  "Dermatologist",
  "Dentist",
  "Orthopedic",
  "Gastroenterologist",
  "ENT Specialist",
  "Pediatrician",
  "Neurologist",
  "Ophthalmologist",
] as const;

export type Specialization = (typeof SUPPORTED_SPECIALIZATIONS)[number];

/* ---- Location (Step 6) ---- */

export interface LocationInput {
  latitude: number;
  longitude: number;
}

export interface LocationValidation {
  valid: true;
  latitude: number;
  longitude: number;
}

export interface ManualLocation {
  valid: true;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

export interface SupportedCity {
  city: string;
  doctor_count: number;
  latitude: number | null;
  longitude: number | null;
}

/* ---- AI analysis (Step 5) ---- */

export interface MedicalProblemAnalysis {
  specialization: Specialization;
  urgency: Urgency;
  summary: string;
  possible_keywords: string[];
}

/* ---- Doctors & reviews (Steps 3–4) ---- */

/** JSONB weekly schedule: day key -> [start, end] 24h intervals. */
export type Availability = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", [string, string][]>>;

export interface DoctorSummary {
  id: number;
  name: string;
  specialization: Specialization;
  qualification: string;
  experience_years: number;
  languages: string[];
  consultation_fee: number;
  clinic_name: string;
  city: string;
  rating: number;
  review_count: number;
  availability: Availability;
  profile_image: string | null;
  is_demo: boolean;
}

export interface DoctorListItem extends DoctorSummary {
  address: string;
  latitude: number;
  longitude: number;
  bio: string | null;
}

export interface DoctorDetail extends DoctorListItem {
  verified: boolean;
  availability_summary: string;
  created_at: string;
  updated_at: string;
}

export interface DoctorListResponse {
  items: DoctorListItem[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
}

export interface Review {
  id: number;
  reviewer_name: string;
  rating: number;
  comment: string | null;
  created_at: string;
  verified_visit: boolean;
  is_demo: boolean;
}

export interface DoctorReviewsResponse {
  doctor_id: number;
  reviews: Review[];
  total: number;
  page: number;
  page_size: number;
}

/* ---- Matching (Step 7) ---- */

export interface MatchRequest extends LocationInput {
  problem: string;
  language?: string | null;
}

export interface MatchResult {
  doctor: DoctorSummary;
  distance_km: number;
  match_score: number;
  match_reasons: string[];
}

export interface MatchResponse {
  status: MatchStatus;
  analysis: MedicalProblemAnalysis | null;
  results: MatchResult[];
  total_results: number;
  message: string | null;
}

/* ---- Health ---- */

export interface HealthStatus {
  status: string;
}

export interface HealthDbStatus {
  status: string;
  database: "connected" | "unavailable";
}
