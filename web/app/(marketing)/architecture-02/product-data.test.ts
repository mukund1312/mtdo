import { describe, expect, it, vi } from "vitest";

import { formatDuration, heatLevel, utcDateRange, utcToday } from "./product-data";

describe("Architecture 02 product data", () => {
  it("creates an inclusive UTC date window", () => {
    expect(utcDateRange(3, "2026-09-07")).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("defaults utcToday() to UTC, unchanged from every existing call site's behavior", () => {
    vi.setSystemTime(new Date("2026-09-07T23:30:00.000Z"));
    expect(utcToday()).toBe("2026-09-07");
    vi.useRealTimers();
  });

  it("computes today in a given time zone, not just UTC", () => {
    // 23:30 UTC is already the next calendar day in a positive-offset zone.
    vi.setSystemTime(new Date("2026-09-07T23:30:00.000Z"));
    expect(utcToday("Asia/Kolkata")).toBe("2026-09-08");
    vi.useRealTimers();
  });

  it("computes today in a negative-offset zone without shifting the wrong direction", () => {
    // 00:30 UTC is still the previous calendar day in a negative-offset zone
    // -- the exact case that would silently break if a date range's
    // internal UTC anchor were ever reformatted in a non-UTC zone (see
    // utcDateRange's own comment on why it deliberately does not do this).
    vi.setSystemTime(new Date("2026-09-08T00:30:00.000Z"));
    expect(utcToday("America/Los_Angeles")).toBe("2026-09-07");
    vi.useRealTimers();
  });

  it("utcDateRange stays anchored to the given endDate regardless of what zone produced it", () => {
    // Proves the range-listing logic is genuinely zone-agnostic once handed
    // a calendar-date string -- same endDate, same result, independent of
    // which zone's utcToday() call produced that string upstream.
    expect(utcDateRange(3, utcToday("Asia/Kolkata"))).toHaveLength(3);
    expect(utcDateRange(3, "2026-09-08")).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
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
