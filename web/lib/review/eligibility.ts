// Centralized eligibility thresholds and helpers -- see the Review page
// audit (2026-09-14): several cards were presenting real percentages with
// full visual confidence off a single observation (e.g. one 3-minute
// session rendering as a 100%-wide session-quality bar). This file exists
// so "is there enough evidence to show a confident metric" is answered in
// one place, not re-derived per component.

export const SESSION_QUALITY_MIN_SESSIONS = 3;

export interface EligibilityResult {
  state: "empty" | "insufficient" | "eligible";
  sampleSize: number;
  requiredSampleSize?: number;
}

export function sessionQualityEligibility(totalSessions: number): EligibilityResult {
  if (totalSessions === 0) return { state: "empty", sampleSize: 0 };
  if (totalSessions < SESSION_QUALITY_MIN_SESSIONS) {
    return { state: "insufficient", sampleSize: totalSessions, requiredSampleSize: SESSION_QUALITY_MIN_SESSIONS };
  }
  return { state: "eligible", sampleSize: totalSessions };
}
