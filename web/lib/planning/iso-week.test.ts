import { describe, expect, it } from "vitest";
import {
  defaultReviewWeek,
  isValidIsoWeek,
  isoWeekOf,
  isoWeekStart,
  nextIsoWeek,
  previousIsoWeek,
  todayInZone,
} from "./iso-week";

// These must agree with `public.iso_week_start()` (migrations/0021) exactly --
// the engine reads a week out of SQL and writes one back, and a one-week
// disagreement between the two would review the wrong seven days while
// looking entirely correct. The year-boundary cases below are the ones where
// naive implementations diverge, and 13_weekly_performance.sql asserts the
// same three values on the SQL side.

describe("isoWeekStart", () => {
  it("returns the Monday of an ordinary week", () => {
    expect(isoWeekStart("2026-W37").toISOString().slice(0, 10)).toBe("2026-09-07");
  });

  it("puts week 01 in the previous December when January 1 falls mid-week", () => {
    expect(isoWeekStart("2026-W01").toISOString().slice(0, 10)).toBe("2025-12-29");
  });

  it("handles a 53-week ISO year", () => {
    expect(isoWeekStart("2020-W53").toISOString().slice(0, 10)).toBe("2020-12-28");
  });

  it("rejects a malformed week rather than coercing it", () => {
    expect(() => isoWeekStart("2026-37")).toThrow(RangeError);
    expect(() => isoWeekStart("2026-W00")).toThrow(RangeError);
    expect(() => isoWeekStart("2026-W54")).toThrow(RangeError);
  });
});

describe("isoWeekOf", () => {
  it("names the week a Monday belongs to", () => {
    expect(isoWeekOf(new Date("2026-09-07T00:00:00Z"))).toBe("2026-W37");
  });

  it("names the same week for that week's Sunday", () => {
    expect(isoWeekOf(new Date("2026-09-13T23:00:00Z"))).toBe("2026-W37");
  });

  it("assigns a late-December date to the NEXT ISO year when it belongs there", () => {
    expect(isoWeekOf(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
  });

  it("assigns an early-January date to the PREVIOUS ISO year when it belongs there", () => {
    expect(isoWeekOf(new Date("2021-01-01T00:00:00Z"))).toBe("2020-W53");
  });

  it("round-trips against isoWeekStart for every week of a year", () => {
    for (let w = 1; w <= 52; w += 1) {
      const iso = `2026-W${String(w).padStart(2, "0")}`;
      expect(isoWeekOf(isoWeekStart(iso))).toBe(iso);
    }
  });
});

describe("previousIsoWeek / nextIsoWeek", () => {
  it("steps back and forward by one week", () => {
    expect(previousIsoWeek("2026-W37")).toBe("2026-W36");
    expect(nextIsoWeek("2026-W37")).toBe("2026-W38");
  });

  it("crosses a year boundary in both directions", () => {
    expect(previousIsoWeek("2026-W01")).toBe("2025-W52");
    expect(nextIsoWeek("2025-W52")).toBe("2026-W01");
  });

  it("crosses into a 53-week year correctly", () => {
    expect(nextIsoWeek("2020-W52")).toBe("2020-W53");
    expect(nextIsoWeek("2020-W53")).toBe("2021-W01");
  });
});

describe("isValidIsoWeek", () => {
  it("accepts well-formed weeks and rejects everything else", () => {
    expect(isValidIsoWeek("2026-W01")).toBe(true);
    expect(isValidIsoWeek("2026-W53")).toBe(true);
    expect(isValidIsoWeek("2026-W54")).toBe(false);
    expect(isValidIsoWeek("2026-W00")).toBe(false);
    expect(isValidIsoWeek("2026-W1")).toBe(false);
    expect(isValidIsoWeek("")).toBe(false);
  });
});

describe("todayInZone", () => {
  it("reads the local date in the given zone, not the server's", () => {
    // 2026-09-07T22:00Z is already the 8th in Tokyo (+09:00).
    const at = new Date("2026-09-07T22:00:00Z");
    expect(todayInZone("Asia/Tokyo", at).toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(todayInZone("UTC", at).toISOString().slice(0, 10)).toBe("2026-09-07");
    // ...and still the 7th in Los Angeles (-07:00).
    expect(todayInZone("America/Los_Angeles", at).toISOString().slice(0, 10)).toBe("2026-09-07");
  });

  it("falls back to UTC for a null zone, matching coalesce(profiles.timezone, 'UTC')", () => {
    const at = new Date("2026-09-07T22:00:00Z");
    expect(todayInZone(null, at).toISOString().slice(0, 10)).toBe("2026-09-07");
  });

  it("falls back rather than throwing on a zone the runtime does not know", () => {
    const at = new Date("2026-09-07T22:00:00Z");
    expect(todayInZone("Mars/Olympus_Mons", at).toISOString().slice(0, 10)).toBe("2026-09-07");
  });
});

describe("defaultReviewWeek", () => {
  it("reviews the most recently COMPLETED week, never the one in progress", () => {
    // Wednesday of 2026-W37. Reviewing W37 mid-week would classify on partial
    // data and call every category struggling by Tuesday.
    expect(defaultReviewWeek("UTC", new Date("2026-09-09T12:00:00Z"))).toBe("2026-W36");
  });

  it("is computed in the user's own zone", () => {
    // Monday 2026-09-07T23:00Z is already Tuesday the 8th in Tokyo; both are
    // inside W37, so both review W36.
    expect(defaultReviewWeek("Asia/Tokyo", new Date("2026-09-07T23:00:00Z"))).toBe("2026-W36");
  });
});
