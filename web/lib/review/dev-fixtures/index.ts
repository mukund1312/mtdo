// ?reviewState=empty|early|building|mature -- a dev-only switch to compare
// every Review page maturity tier instantly, without onboarding a fresh
// account and manually running real focus sessions each time (audit item
// 46). Gated on NODE_ENV so this can never fire against the deployed
// production build, regardless of what URL a visitor types -- "not exposed
// in production" is enforced structurally, not just by omitting a UI toggle.

import type { AnalyticsMaturity } from "./types";

export { buildReviewFixture } from "./generate";
export type { AnalyticsMaturity, ReviewFixtureBundle } from "./types";

const VALID: AnalyticsMaturity[] = ["empty", "early", "building", "mature"];

export function getDevReviewStateOverride(): AnalyticsMaturity | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("reviewState");
  return VALID.includes(value as AnalyticsMaturity) ? (value as AnalyticsMaturity) : null;
}
