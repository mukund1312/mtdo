import { describe, expect, it, vi } from "vitest";

import { buildCoachingContent, hasCoachingSetup } from "./build-coaching-content";

describe("buildCoachingContent", () => {
  it("falls all the way back to the fully generic library when nothing is set", () => {
    const content = buildCoachingContent(null, null);
    expect(content.focus_on).toEqual([
      "What problem does this solve?",
      "Why does it exist?",
      "What assumptions does it make?",
      "What are the tradeoffs?",
      "What are the edge cases?",
    ]);
    expect(content.ask_yourself).toEqual([
      "What is it?",
      "Why is it needed?",
      "How does it work?",
      "When should I use it?",
      "When should I NOT use it?",
    ]);
    expect(content.related_topics).toEqual([]);
  });

  it("falls back to the built-in topic_type bucket when only topic_type is set", () => {
    const content = buildCoachingContent(null, { topic_type: "dsa" });
    expect(content.ask_yourself).toEqual([
      "What is the brute-force solution?",
      "Why is it slow?",
      "What observation improves it?",
      "What data structure helps?",
      "Time Complexity?",
      "Space Complexity?",
      "Edge Cases?",
    ]);
    expect(content.interview_check).toEqual([
      "Solve from scratch.",
      "Explain intuition.",
      "Explain complexity.",
      "Optimize further.",
      "Re-derive tomorrow.",
    ]);
    // Not overridden by topic_type -- stays fully generic.
    expect(content.focus_on).toEqual(["What problem does this solve?", "Why does it exist?", "What assumptions does it make?", "What are the tradeoffs?", "What are the edge cases?"]);
  });

  it("prefers the field's coaching_framework over the topic_type bucket", () => {
    const content = buildCoachingContent(null, {
      coaching_framework: { ask_yourself: ["What is a hashmap collision?"], focus_on: ["Amortized O(1) lookup."] },
      topic_type: "dsa",
    });
    expect(content.ask_yourself).toEqual(["What is a hashmap collision?"]);
    expect(content.focus_on).toEqual(["Amortized O(1) lookup."]);
    // Not personalized in the field framework -- falls to the topic_type bucket, not all the way to generic.
    expect(content.interview_check).toEqual([
      "Solve from scratch.",
      "Explain intuition.",
      "Explain complexity.",
      "Optimize further.",
      "Re-derive tomorrow.",
    ]);
  });

  it("prefers the task's own metadata over everything else, per field independently", () => {
    const content = buildCoachingContent(
      { focus_points: ["Find the pair without a second pass."], mistakes: ["Forgetting to check the empty array case."] },
      {
        coaching_framework: { ask_yourself: ["What is a hashmap collision?"], focus_on: ["Amortized O(1) lookup."] },
        topic_type: "dsa",
      },
    );
    expect(content.focus_on).toEqual(["Find the pair without a second pass."]);
    expect(content.mistakes).toEqual(["Forgetting to check the empty array case."]);
    // Task metadata didn't set ask_yourself -- falls through to the field framework, not generic.
    expect(content.ask_yourself).toEqual(["What is a hashmap collision?"]);
  });

  it("uses the task's own first tip as pro_tip instead of a random expert tip when set", () => {
    const content = buildCoachingContent({ tips: ["Draw the recursion tree first."] }, null);
    expect(content.pro_tip).toBe("Draw the recursion tree first.");
  });

  it("picks a random expert tip when no tip is set anywhere", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const content = buildCoachingContent(null, null);
    expect(content.pro_tip).toBe("Don't memorize solutions. Memorize reasoning.");
    randomSpy.mockRestore();
  });

  it("treats an empty array the same as unset -- falls through, doesn't stop at an empty list", () => {
    const content = buildCoachingContent({ focus_points: [] }, { coaching_framework: { focus_on: ["Real field content."] } });
    expect(content.focus_on).toEqual(["Real field content."]);
  });
});

describe("hasCoachingSetup", () => {
  it("is false when nothing at all is set", () => {
    expect(hasCoachingSetup(null, null)).toBe(false);
    expect(hasCoachingSetup({}, {})).toBe(false);
  });

  it("is true when the task has its own coaching metadata", () => {
    expect(hasCoachingSetup({ focus_points: ["x"] }, null)).toBe(true);
  });

  it("is true when only topic_type is set", () => {
    expect(hasCoachingSetup(null, { topic_type: "dsa" })).toBe(true);
  });

  it("is true when only coaching_framework is set", () => {
    expect(hasCoachingSetup(null, { coaching_framework: { focus_on: ["x"] } })).toBe(true);
  });
});
