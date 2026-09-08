import { describe, expect, it } from "vitest";

import { buildFallbackPlan } from "./fallback";
import { parseGeneratedPlan } from "./parse";
import { buildPlanPrompt } from "./prompt";
import { PlanGenerationError } from "./types";

function generatedPlan(categories: unknown[] = [generatedCategory()]): string {
  return JSON.stringify({
    app_name: "Interview Route",
    goal_line: "Become confident with backend interviews.",
    categories,
  });
}

function generatedCategory(overrides: Record<string, unknown> = {}) {
  return {
    name: "backend_foundations",
    label: "Backend Foundations",
    days: [0],
    min_blocks: 1,
    score_weight: 100,
    topic_type: "backend",
    curriculum: [
      [
        {
          task: "Model a small REST API.",
          focus_points: ["Choose resources before endpoints."],
          questions: ["What belongs in the response body?"],
        },
      ],
      ["Review the API boundary and its trade-offs."],
    ],
    ...overrides,
  };
}

describe("parseGeneratedPlan", () => {
  it("accepts a fenced model response and preserves rich task guidance", () => {
    const raw = `Here is the plan:\n\n\`\`\`json\n${generatedPlan()}\n\`\`\``;

    const plan = parseGeneratedPlan(raw);

    expect(plan.app_name).toBe("Interview Route");
    expect(plan.categories).toHaveLength(1);
    expect(plan.categories[0]).toMatchObject({
      name: "backend_foundations",
      topic_type: "backend",
    });
    expect(plan.categories[0]?.curriculum[0]?.[0]).toMatchObject({
      task: "Model a small REST API.",
      focus_points: ["Choose resources before endpoints."],
    });
  });

  it("rejects duplicate category identifiers before a plan can be persisted", () => {
    const category = generatedCategory();

    expect(() => parseGeneratedPlan(generatedPlan([category, category]))).toThrow(
      /Duplicate category name "backend_foundations"/,
    );
  });

  it("rejects a curriculum that does not cover two weeks of scheduled days", () => {
    const invalidCategory = generatedCategory({ curriculum: [["Only one day"]] });

    expect(() => parseGeneratedPlan(generatedPlan([invalidCategory]))).toThrow(PlanGenerationError);
    expect(() => parseGeneratedPlan(generatedPlan([invalidCategory]))).toThrow(
      /expected 2 \(days.length 1 \* 2 weeks\)/,
    );
  });

  it("rejects unsupported topic types instead of accepting a drifted schema", () => {
    const invalidCategory = generatedCategory({ topic_type: "frontend" });

    expect(() => parseGeneratedPlan(generatedPlan([invalidCategory]))).toThrow(
      /topic_type must be one of dsa, backend, database, system_design/,
    );
  });

  it("accepts a missing schema_version as mtdo.plan.v1", () => {
    expect(() => parseGeneratedPlan(generatedPlan())).not.toThrow();
  });

  it("accepts an explicit, correct schema_version", () => {
    const raw = JSON.stringify({
      schema_version: "mtdo.plan.v1",
      app_name: "Interview Route",
      goal_line: "Become confident with backend interviews.",
      categories: [generatedCategory()],
    });
    expect(() => parseGeneratedPlan(raw)).not.toThrow();
  });

  it("rejects an unrecognized schema_version", () => {
    const raw = JSON.stringify({
      schema_version: "mtdo.plan.v2",
      app_name: "Interview Route",
      goal_line: "Become confident with backend interviews.",
      categories: [generatedCategory()],
    });
    expect(() => parseGeneratedPlan(raw)).toThrow(/Unsupported schema_version "mtdo.plan.v2"/);
  });

  it("with weekCount: 'any', accepts any whole number of weeks, not just 2", () => {
    const oneWeek = generatedCategory({ curriculum: [["Only one day"]] });
    const plan = parseGeneratedPlan(generatedPlan([oneWeek]), { weekCount: "any" });
    expect(plan.categories[0]?.curriculum).toHaveLength(1);

    const threeWeeks = generatedCategory({ curriculum: [["a"], ["b"], ["c"]] });
    const plan3 = parseGeneratedPlan(generatedPlan([threeWeeks]), { weekCount: "any" });
    expect(plan3.categories[0]?.curriculum).toHaveLength(3);
  });

  it("with weekCount: 'any', still rejects a partial week", () => {
    // days.length is 2 here (0 and 2 from generatedCategory's default `days:
    // [0]`... use an explicit 2-day category so a 3-entry curriculum is
    // unambiguously a partial week, not a valid 1.5x something.
    const category = generatedCategory({ days: [0, 2], curriculum: [["a"], ["b"], ["c"]] });
    expect(() => parseGeneratedPlan(generatedPlan([category]), { weekCount: "any" })).toThrow(
      /isn't a whole number of 2-day weeks/,
    );
  });
});

describe("onboarding plan fallbacks", () => {
  it("creates a usable starter plan when generation is unavailable", () => {
    const plan = buildFallbackPlan({ appName: "  My Route  ", goalLine: "  Learn SQL  " });

    expect(plan).toMatchObject({
      app_name: "My Route",
      goal_line: "Learn SQL",
    });
    expect(plan.categories).toHaveLength(2);
    expect(plan.categories.every((category) => category.curriculum.flat().length > 0)).toBe(true);
  });

  it("uses safe defaults for blank optional onboarding labels", () => {
    const plan = buildFallbackPlan({ appName: "  ", goalLine: " " });

    expect(plan.app_name).toBe("MTDO");
    expect(plan.goal_line).toBe("Build a consistent daily practice habit.");
  });
});

describe("buildPlanPrompt", () => {
  it("uses the selected days and strips empty focus areas from the model context", () => {
    const prompt = buildPlanPrompt({
      appName: "  Career Route  ",
      goalLine: "Land a backend role",
      focusAreas: ["SQL", " ", "System design"],
      experienceLevel: "intermediate",
      weeklyDaysAvailable: [0, 2, 5],
      notes: "  Prefer practical exercises.  ",
    });

    expect(prompt).toContain('Call the app "Career Route"');
    expect(prompt).toContain("They can study on: Mon, Wed, Sat.");
    expect(prompt).toContain("separate subjects tracked: SQL, System design");
    expect(prompt).toContain("Additional context from the user: Prefer practical exercises.");
  });
});
