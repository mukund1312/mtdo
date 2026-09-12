import { describe, expect, it } from "vitest";

import { laneStyle, layoutDayOverlaps, type OverlapInterval } from "./calendar-overlap";

function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 12, hour, minute, 0, 0);
}

function interval(id: string, startHour: number, endHour: number): OverlapInterval {
  return { id, start: at(startHour), end: at(endHour) };
}

describe("layoutDayOverlaps (Time deck side-by-side lane layout)", () => {
  it("gives every block a single lane when nothing overlaps", () => {
    const result = layoutDayOverlaps([interval("a", 9, 10), interval("b", 11, 12), interval("c", 14, 15)]);
    for (const id of ["a", "b", "c"]) {
      expect(result.get(id)).toEqual({ lane: 0, laneCount: 1 });
    }
  });

  it("splits two overlapping blocks into two lanes", () => {
    const result = layoutDayOverlaps([interval("a", 9, 10), { id: "b", start: at(9, 30), end: at(10, 30) }]);
    const a = result.get("a")!;
    const b = result.get("b")!;
    expect(a.laneCount).toBe(2);
    expect(b.laneCount).toBe(2);
    expect(a.lane).not.toBe(b.lane);
  });

  it("a block reuses the first lane freed by an earlier, non-overlapping block in the same cluster", () => {
    // a: 9-10, b: 9:30-10:30 (overlaps a -> needs lane 1), c: 10-11 (starts
    // exactly when a ends, so it can reuse lane 0 -- still one connected
    // cluster via b, which bridges a and c in time).
    const blocks = [interval("a", 9, 10), { id: "b", start: at(9, 30), end: at(10, 30) }, interval("c", 10, 11)];
    const result = layoutDayOverlaps(blocks);
    expect(result.get("a")).toEqual({ lane: 0, laneCount: 2 });
    expect(result.get("b")).toEqual({ lane: 1, laneCount: 2 });
    expect(result.get("c")).toEqual({ lane: 0, laneCount: 2 });
  });

  it("computes real max-concurrency per cluster, not a single day-wide count", () => {
    // Cluster 1 (9-10): two overlapping blocks -> laneCount 2.
    // Cluster 2 (14-16): three mutually overlapping blocks -> laneCount 3.
    // A whole-day-wide algorithm would wrongly force cluster 1 to laneCount 3 too.
    const blocks = [
      interval("a1", 9, 10),
      interval("a2", 9, 10),
      interval("b1", 14, 16),
      interval("b2", 14, 16),
      interval("b3", 14, 16),
    ];
    const result = layoutDayOverlaps(blocks);
    expect(result.get("a1")!.laneCount).toBe(2);
    expect(result.get("a2")!.laneCount).toBe(2);
    expect(result.get("b1")!.laneCount).toBe(3);
    expect(result.get("b2")!.laneCount).toBe(3);
    expect(result.get("b3")!.laneCount).toBe(3);
  });

  it("a lane index is never occupied by two blocks whose ranges overlap", () => {
    const dense: OverlapInterval[] = [
      interval("x1", 9, 12),
      { id: "x2", start: at(9, 30), end: at(10, 30) },
      { id: "x3", start: at(10, 0), end: at(11, 0) },
      { id: "x4", start: at(11, 30), end: at(12, 30) },
    ];
    const result = layoutDayOverlaps(dense);
    const byLane = new Map<number, OverlapInterval[]>();
    for (const block of dense) {
      const placement = result.get(block.id)!;
      const list = byLane.get(placement.lane) ?? [];
      list.push(block);
      byLane.set(placement.lane, list);
    }
    for (const [, laneBlocks] of byLane) {
      for (let i = 0; i < laneBlocks.length; i++) {
        for (let j = i + 1; j < laneBlocks.length; j++) {
          const a = laneBlocks[i]!;
          const b = laneBlocks[j]!;
          const overlaps = a.start < b.end && b.start < a.end;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it("returns an empty map for no intervals", () => {
    expect(layoutDayOverlaps([]).size).toBe(0);
  });
});

describe("laneStyle", () => {
  it("returns null for a single lane, deferring to the existing CSS left/right:3px rule", () => {
    expect(laneStyle(0, 1)).toBeNull();
  });

  it("emits calc() left/width for a multi-lane placement", () => {
    const style = laneStyle(1, 2);
    expect(style).not.toBeNull();
    expect(style!.width).toContain("calc(");
    expect(style!.left).toContain("calc(");
    // lane 1 of 2 should be offset from lane 0's left edge.
    expect(style!.left).toContain("1 *");
  });
});
