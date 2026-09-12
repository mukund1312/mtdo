// Overlap-lane layout for the Time deck's Day/Week hour grid (calendar-deck
// extension, following Phase 6's shipped calendar). Google Calendar's classic
// "side by side" layout for concurrent events: N blocks whose time ranges
// overlap within one day column split that column's width into N lanes so
// every block stays visible and independently clickable/draggable, instead
// of stacking on top of each other (today's behavior with no lane-splitting
// at all).
//
// Deliberately kept as a separate pure module from calendar-deck.tsx's
// eventGeometry() -- this only ever touches HORIZONTAL placement (lane index
// / lane count -> left/width). It must never be tempted into recomputing
// top/height; that vertical math is ROW_HEIGHT-driven and PR #161 spent real
// effort making it pixel-accurate. Two independent inputs (start/end for
// vertical position, lane/laneCount for horizontal position) computed by two
// independent functions is what keeps that geometry safe from drift.

export type OverlapInterval = { id: string; start: Date; end: Date };

export type LanePlacement = { lane: number; laneCount: number };

/**
 * Assigns each interval a lane index and a lane count, per Google
 * Calendar's own algorithm:
 *
 *   1. Sort by start time (longer events first on a tie, so a long event
 *      claims lane 0 and short events that start at the same moment don't
 *      arbitrarily "win" the leftmost slot).
 *   2. Walk left to right, chaining overlapping/adjacent-in-time intervals
 *      into clusters -- a cluster is a maximal run where each interval
 *      starts before the running maximum end time of everything already in
 *      the cluster. Two intervals don't need to directly overlap each other
 *      to share a cluster, only to be connected through a chain of
 *      overlaps (the standard "merge overlapping intervals" definition).
 *   3. Within each cluster, greedily assign every interval to the
 *      lowest-numbered lane whose last-placed interval already ended --
 *      "a block's lane = the first lane index not occupied by another
 *      block whose time range overlaps it". This is the textbook minimum
 *      interval-partitioning algorithm, so the lane count within a cluster
 *      always equals that cluster's true max concurrent overlap, never an
 *      overestimate.
 *
 * A day with no overlaps at all returns every block at { lane: 0,
 * laneCount: 1 } -- identical to today's un-split rendering, so nothing
 * changes visually for the common case.
 */
export function layoutDayOverlaps(intervals: OverlapInterval[]): Map<string, LanePlacement> {
  const result = new Map<string, LanePlacement>();
  if (intervals.length === 0) return result;

  const sorted = [...intervals].sort((a, b) => {
    const startDiff = a.start.getTime() - b.start.getTime();
    if (startDiff !== 0) return startDiff;
    return b.end.getTime() - a.end.getTime();
  });

  let cluster: OverlapInterval[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    assignLanesWithinCluster(cluster, result);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const interval of sorted) {
    if (cluster.length > 0 && interval.start.getTime() >= clusterEnd) {
      flush();
    }
    cluster.push(interval);
    clusterEnd = Math.max(clusterEnd, interval.end.getTime());
  }
  flush();

  return result;
}

function assignLanesWithinCluster(cluster: OverlapInterval[], result: Map<string, LanePlacement>): void {
  // lanes[i] holds the end time (ms) of the last interval placed in lane i.
  const laneEnds: number[] = [];
  const laneOfId = new Map<string, number>();

  for (const interval of cluster) {
    let placedLane = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      const laneEnd = laneEnds[i];
      if (laneEnd !== undefined && laneEnd <= interval.start.getTime()) {
        placedLane = i;
        break;
      }
    }
    if (placedLane === -1) {
      placedLane = laneEnds.length;
      laneEnds.push(interval.end.getTime());
    } else {
      laneEnds[placedLane] = interval.end.getTime();
    }
    laneOfId.set(interval.id, placedLane);
  }

  const laneCount = laneEnds.length;
  for (const interval of cluster) {
    result.set(interval.id, { lane: laneOfId.get(interval.id) ?? 0, laneCount });
  }
}

/**
 * CSS left/width for a lane, expressed as calc() strings so the browser
 * resolves the mix of `%` (the day column's own responsive width) and `px`
 * (the fixed edge inset / inter-lane gap) -- laneCount and lane are plain
 * JS numbers known at render time, so this is the only place that needs to
 * emit calc() at all.
 *
 * Returns `null` for the common laneCount<=1 case so the caller falls back
 * to calendar-deck.css's existing `left:3px;right:3px` rule untouched,
 * rather than emitting an inline style that merely reproduces it.
 */
export function laneStyle(lane: number, laneCount: number): { left: string; width: string } | null {
  if (laneCount <= 1) return null;
  const edgeInset = 3; // matches .a02-calendar-event's existing left/right:3px
  const gap = 3; // gutter between adjacent lanes
  const reserved = edgeInset * 2 + gap * (laneCount - 1);
  const width = `calc((100% - ${reserved}px) / ${laneCount})`;
  const left = `calc(${edgeInset}px + ${lane} * (${width} + ${gap}px))`;
  return { left, width };
}
