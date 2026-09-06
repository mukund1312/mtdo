import { describe, expect, it } from "vitest";

import { formatDuration, heatLevel, utcDateRange } from "./product-data";

describe("Architecture 02 product data", () => {
  it("creates an inclusive UTC date window", () => {
    expect(utcDateRange(3, "2026-09-07")).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("maps only actual focus duration into the documented heat cells", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(29 * 60)).toBe(1);
    expect(heatLevel(30 * 60)).toBe(2);
    expect(heatLevel(60 * 60)).toBe(3);
    expect(heatLevel(120 * 60)).toBe(4);
  });

  it("formats focus time without manufacturing a score", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(90 * 60)).toBe("1h 30m");
  });
});
