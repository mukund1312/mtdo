import { describe, expect, it } from "vitest";

import { computeStreaks, type StreakRollup } from "./streak";

function rollup(date: string, blocks_done: number): StreakRollup {
  return { blocks_done, date };
}

describe("computeStreaks", () => {
  it("is 0/0 with no recorded activity at all", () => {
    expect(computeStreaks([], "2026-09-08")).toEqual({ current: 0, longest: 0 });
  });

  it("counts back from yesterday, excluding today itself", () => {
    const rollups = [
      rollup("2026-09-08", 5), // today -- must not count toward "current"
      rollup("2026-09-07", 3),
      rollup("2026-09-06", 1),
      rollup("2026-09-05", 0), // breaks the streak
    ];
    // "longest" includes today itself (2026-09-08 is active too), so the
    // 3-day run 09-06..09-08 beats "current"'s 2-day count, which excludes
    // today by design (see computeStreaks' own doc comment).
    expect(computeStreaks(rollups, "2026-09-08")).toEqual({ current: 2, longest: 3 });
  });

  it("stops at the first inactive day walking backward", () => {
    const rollups = [rollup("2026-09-07", 1), rollup("2026-09-06", 0), rollup("2026-09-05", 1)];
    expect(computeStreaks(rollups, "2026-09-08").current).toBe(1);
  });

  it("treats a missing row the same as an inactive day", () => {
    // 2026-09-06 has no row at all (not just blocks_done: 0).
    const rollups = [rollup("2026-09-07", 2)];
    expect(computeStreaks(rollups, "2026-09-08").current).toBe(1);
  });

  it("longest can exceed current when an older run was longer than the active one", () => {
    const rollups = [
      rollup("2026-09-01", 1),
      rollup("2026-09-02", 1),
      rollup("2026-09-03", 1),
      rollup("2026-09-04", 1),
      rollup("2026-09-05", 0),
      rollup("2026-09-06", 0),
      rollup("2026-09-07", 1),
    ];
    const result = computeStreaks(rollups, "2026-09-08");
    expect(result.current).toBe(1);
    expect(result.longest).toBe(4);
  });

  it("longest is never smaller than current, even if the scan window rounds oddly", () => {
    const rollups = Array.from({ length: 10 }, (_, i) => rollup(`2026-08-2${i}`.slice(0, 10), 1));
    const result = computeStreaks(rollups, "2026-08-30", 5);
    expect(result.longest).toBeGreaterThanOrEqual(result.current);
  });
});
