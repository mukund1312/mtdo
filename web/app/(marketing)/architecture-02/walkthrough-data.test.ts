import { describe, expect, it } from "vitest";

import { SIGNAL_DECK_WALKTHROUGH } from "./walkthrough-data";

describe("Signal Deck walkthrough", () => {
  it("covers the shipped route, work, focus, and review loop in order", () => {
    expect(SIGNAL_DECK_WALKTHROUGH.map((step) => step.id)).toEqual(["route", "work", "focus", "review"]);
  });

  it("only points at decks that exist in Architecture 02", () => {
    expect(SIGNAL_DECK_WALKTHROUGH.map((step) => step.deck)).toEqual(["home", "work", "home", "review"]);
  });
});
