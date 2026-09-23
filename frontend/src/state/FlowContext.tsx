/**
 * Lightweight flow state (Steps 9.3–9.4): carries the user's chosen
 * location, problem description and AI analysis across
 * /location → /problem → /results.
 *
 * Privacy: precise coordinates, the medical problem text and the analysis
 * live only in React state + sessionStorage (survives a reload in the same
 * tab, cleared when the tab closes). Nothing is ever persisted permanently
 * and no analytics/third party ever sees it.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { MatchResponse, MedicalProblemAnalysis } from "../types/api";

export interface FlowLocation {
  /** How the location was obtained — drives honest labelling later. */
  method: "browser" | "city";
  /** City name (manual fallback) or a friendly label for a browser fix. */
  label: string;
  /** Null only when a supported city has no known centre (future-proof). */
  latitude: number | null;
  longitude: number | null;
}

interface FlowState {
  location: FlowLocation | null;
  setLocation: (location: FlowLocation) => void;
  resetLocation: () => void;

  /** The user's problem description, exactly as typed (may contain spaces). */
  problem: string | null;
  setProblem: (problem: string) => void;

  /** Structured AI understanding of `problem` (never a diagnosis). */
  analysis: MedicalProblemAnalysis | null;
  setAnalysis: (analysis: MedicalProblemAnalysis) => void;
  resetAnalysis: () => void;

  /** The matching engine's response for the current flow — lets the doctor
   *  profile show the real "why recommended" context without refetching. */
  matchResponse: MatchResponse | null;
  setMatchResponse: (response: MatchResponse) => void;

  /** Clear the entire flow (location + problem + analysis) — "Start over". */
  resetFlow: () => void;
}

const LOCATION_KEY = "mediqo.flow.location";
const PROBLEM_KEY = "mediqo.flow.problem";
const ANALYSIS_KEY = "mediqo.flow.analysis";
const MATCH_KEY = "mediqo.flow.match";

const FlowContext = createContext<FlowState | null>(null);

function loadJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLocation(value: unknown): value is FlowLocation {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as FlowLocation).method === "browser" || (value as FlowLocation).method === "city") &&
    typeof (value as FlowLocation).label === "string"
  );
}

function isAnalysis(value: unknown): value is MedicalProblemAnalysis {
  if (typeof value !== "object" || value === null) return false;
  const v = value as MedicalProblemAnalysis;
  return (
    typeof v.specialization === "string" &&
    (v.urgency === "normal" || v.urgency === "urgent" || v.urgency === "emergency") &&
    typeof v.summary === "string" &&
    Array.isArray(v.possible_keywords)
  );
}

function isMatchResponse(value: unknown): value is MatchResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as MatchResponse;
  return (
    (v.status === "success" || v.status === "emergency" || v.status === "no_match") &&
    Array.isArray(v.results)
  );
}

export function FlowProvider({ children }: { children: ReactNode }) {
  const [location, setLocationState] = useState<FlowLocation | null>(() => loadJson(LOCATION_KEY, isLocation));
  const [problem, setProblemState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(PROBLEM_KEY);
    } catch {
      return null;
    }
  });
  const [analysis, setAnalysisState] = useState<MedicalProblemAnalysis | null>(() =>
    loadJson(ANALYSIS_KEY, isAnalysis),
  );
  const [matchResponse, setMatchResponseState] = useState<MatchResponse | null>(() =>
    loadJson(MATCH_KEY, isMatchResponse),
  );

  const setLocation = useCallback((next: FlowLocation) => {
    setLocationState(next);
    try {
      sessionStorage.setItem(LOCATION_KEY, JSON.stringify(next));
    } catch {
      /* private browsing — state stays in memory only */
    }
  }, []);

  const resetLocation = useCallback(() => {
    setLocationState(null);
    try {
      sessionStorage.removeItem(LOCATION_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const setProblem = useCallback((next: string) => {
    setProblemState(next);
    try {
      sessionStorage.setItem(PROBLEM_KEY, next);
    } catch {
      /* private browsing — state stays in memory only */
    }
  }, []);

  const setAnalysis = useCallback((next: MedicalProblemAnalysis) => {
    setAnalysisState(next);
    try {
      sessionStorage.setItem(ANALYSIS_KEY, JSON.stringify(next));
    } catch {
      /* private browsing — state stays in memory only */
    }
  }, []);

  const resetAnalysis = useCallback(() => {
    setAnalysisState(null);
    setProblemState(null);
    setMatchResponseState(null);
    try {
      sessionStorage.removeItem(ANALYSIS_KEY);
      sessionStorage.removeItem(PROBLEM_KEY);
      sessionStorage.removeItem(MATCH_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const setMatchResponse = useCallback((next: MatchResponse) => {
    setMatchResponseState(next);
    try {
      sessionStorage.setItem(MATCH_KEY, JSON.stringify(next));
    } catch {
      /* private browsing — state stays in memory only */
    }
  }, []);

  const resetFlow = useCallback(() => {
    setLocationState(null);
    setProblemState(null);
    setAnalysisState(null);
    setMatchResponseState(null);
    try {
      sessionStorage.removeItem(LOCATION_KEY);
      sessionStorage.removeItem(PROBLEM_KEY);
      sessionStorage.removeItem(ANALYSIS_KEY);
      sessionStorage.removeItem(MATCH_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({
      location,
      setLocation,
      resetLocation,
      problem,
      setProblem,
      analysis,
      setAnalysis,
      resetAnalysis,
      matchResponse,
      setMatchResponse,
      resetFlow,
    }),
    [location, setLocation, resetLocation, problem, setProblem, analysis, setAnalysis, resetAnalysis, matchResponse, setMatchResponse, resetFlow],
  );

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useFlow(): FlowState {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("useFlow must be used within FlowProvider");
  return ctx;
}
