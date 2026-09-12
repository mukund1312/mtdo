import { describe, expect, it } from "vitest";

import { CATEGORY_COLOR_TOKENS, categoryColorToken } from "./category-color";

describe("categoryColorToken (Time deck per-category colour)", () => {
  it("is deterministic -- the same category_id always gets the same colour", () => {
    const id = "9c3f6e1a-1111-4a2b-8c3d-abcdefabcdef";
    const first = categoryColorToken(id);
    const second = categoryColorToken(id);
    expect(first).toBe(second);
  });

  it("only ever returns a token from the approved Graphite palette", () => {
    const ids = ["a", "b", "c", "sql-fundamentals", "system-design", "00000000-0000-0000-0000-000000000000"];
    for (const id of ids) {
      expect(CATEGORY_COLOR_TOKENS).toContain(categoryColorToken(id));
    }
  });

  it("spreads distinct category ids across more than one slot", () => {
    // Not a strict uniformity requirement (4 slots, small sample can
    // collide), just confirms this isn't secretly a constant function.
    const ids = Array.from({ length: 12 }, (_, i) => `category-${i}`);
    const tokens = new Set(ids.map((id) => categoryColorToken(id)));
    expect(tokens.size).toBeGreaterThan(1);
  });

  it("two categories a real plan is likely to have side by side land on different slots", () => {
    expect(categoryColorToken("sql-fundamentals")).not.toBe(categoryColorToken("system-design"));
  });
});
