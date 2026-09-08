import { describe, expect, it } from "vitest";

import { kanbanMetadataFor, priorityLabel } from "./kanban-metadata";

describe("Kanban metadata adapter", () => {
  it("provides stable UI-only metadata for the same block", () => {
    expect(kanbanMetadataFor({ id: "block-alpha" })).toEqual(kanbanMetadataFor({ id: "block-alpha" }));
  });

  it("only exposes the presentation values supported by the temporary adapter", () => {
    const metadata = kanbanMetadataFor({ id: "block-beta" });
    expect(["high", "medium", "low"]).toContain(metadata.priority);
    expect([25, 45, 60]).toContain(metadata.estimatedMinutes);
    expect(priorityLabel(metadata.priority)).toMatch(/^(High|Medium|Low)$/);
  });
});
