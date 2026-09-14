// Shared shape for the dev-only ?reviewState= fixture switch -- see
// index.ts for the override lookup and generate.ts for the four maturity
// tiers. Each field matches EXACTLY the real type the corresponding
// use-*.ts hook already returns (ReviewDailySummary, ReviewMomentum, etc.)
// -- these are literal fixture objects, not narrowed through the as*()
// validators, since they never pass through JSON/the network.

import type {
  ReviewConsistency,
  ReviewDailySummary,
  ReviewMomentum,
  ReviewTimePatterns,
  StudyProfile,
} from "@/lib/review/types";
import type { WeeklyPerformance } from "@/lib/planning/types";

export type AnalyticsMaturity = "empty" | "early" | "building" | "mature";

export interface ReviewFixtureBundle {
  dailySummary: ReviewDailySummary;
  momentum: ReviewMomentum;
  timePatterns: ReviewTimePatterns;
  consistency: ReviewConsistency;
  weekly: WeeklyPerformance;
  studyProfile: StudyProfile;
}
