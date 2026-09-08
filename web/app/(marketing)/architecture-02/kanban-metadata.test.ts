import { describe, expect, it } from "vitest";

import { isTaskPriority, priorityLabel } from "./kanban-metadata";

describe("Kanban task priority (migrations/0018)", () => {
  it("recognizes every real CHECK-constrained value", () => {
    expect(isTaskPriority("high")).toBe(true);
    expect(isTaskPriority("medium")).toBe(true);
    expect(isTaskPriority("low")).toBe(true);
  });

  it("rejects anything the CHECK constraint wouldn't accept", () => {
    expect(isTaskPriority("urgent")).toBe(false);
    expect(isTaskPriority("")).toBe(false);
  });

  it("formats each priority as a capitalized label", () => {
    expect(priorityLabel("high")).toBe("High");
    expect(priorityLabel("medium")).toBe("Medium");
    expect(priorityLabel("low")).toBe("Low");
  });
});
