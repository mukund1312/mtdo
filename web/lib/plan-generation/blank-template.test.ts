import { describe, expect, it } from "vitest";

import { buildBlankPlanTemplate } from "./blank-template";
import { parseGeneratedPlan } from "./parse";

describe("buildBlankPlanTemplate", () => {
  it("round-trips through parseGeneratedPlan (the Import tab's own validator) with no edits", () => {
    const json = JSON.stringify(buildBlankPlanTemplate());
    const plan = parseGeneratedPlan(json, { weekCount: "any" });

    expect(plan.app_name).toBe("MTDO");
    expect(plan.categories.map((c) => c.name)).toEqual(["science", "sql"]);
  });

  it("includes a non-CS example category with no topic_type", () => {
    const plan = parseGeneratedPlan(JSON.stringify(buildBlankPlanTemplate()), { weekCount: "any" });
    const science = plan.categories.find((c) => c.name === "science");

    expect(science?.topic_type).toBeUndefined();
    expect(science?.coaching_framework?.ask_yourself?.length).toBeGreaterThan(0);
  });

  it("keeps the CS example category to show topic_type still works", () => {
    const plan = parseGeneratedPlan(JSON.stringify(buildBlankPlanTemplate()), { weekCount: "any" });
    const sql = plan.categories.find((c) => c.name === "sql");

    expect(sql?.topic_type).toBe("database");
  });

  it("ignores every underscore-prefixed instructional key, same as goals_template.json's own convention", () => {
    const template = buildBlankPlanTemplate();
    expect(Object.keys(template)).toContain("_instructions");
    expect(Object.keys(template)).toContain("_read_this_first");

    // Never throws on the unrecognized keys -- parseGeneratedPlan simply
    // never reads them.
    expect(() => parseGeneratedPlan(JSON.stringify(template), { weekCount: "any" })).not.toThrow();
  });
});
