// The numbers review_insights() turns on, in one file, with the reasoning
// attached -- same convention as web/lib/planning/thresholds.ts, for the
// same reason: a rules engine whose constants are scattered through its
// branches cannot be argued with, tuned, or audited.
//
// These are STARTING POINTS chosen for defensibility, not tuned against real
// usage data -- there isn't any yet (same standing caveat as the weekly
// engine's own thresholds and effort_v1/momentum_v1's weights). Revisit once
// real usage exists.

/**
 * Below half of what you planned, over the sampled weeks. Strict `<`, so
 * exactly 0.5 does not fire -- same "half, not almost half" reasoning as the
 * weekly engine's own STRUGGLING_COMPLETION_MAX.
 */
export const PLANNING_OVERCOMMIT_MAX = 0.5;

/**
 * A category already has to clear study_profile()'s own postponement_rate > 0
 * gate to be named most_avoided_subject at all -- this raises the bar again,
 * for turning that fact into a NAMED insight the user reads. Strict `>=`.
 */
export const AVOIDANCE_NOTICE_MIN = 0.3;

/** Above this completion_rate, strongest_subject earns a positive callout. */
export const STRONG_SUBJECT_MIN = 0.85;

/**
 * Below this active_days_rate, flag a consistency dip. Deliberately not tied
 * to momentum_score itself -- that number is already smoothed (momentum_v1),
 * and layering a second smoothed threshold on top of a smoothed number would
 * make the insight's own trigger point opaque. active_days_rate is the plain
 * fact underneath it.
 */
export const CONSISTENCY_DIP_MAX = 0.3;
