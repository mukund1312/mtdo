import { describe, expect, it } from "vitest";
import { buildWeeklyProposal } from "./propose";
import { proposeTarget } from "./thresholds";
import { category, week } from "./fixtures";
import type { ProposedChange } from "./types";

/** Index access under `noUncheckedIndexedAccess` -- fails the test loudly rather than yielding undefined. */
function only(changes: ProposedChange[], at = 0): ProposedChange {
  const change = changes[at];
  if (!change) throw new Error(`expected a change at index ${at}, got ${changes.length} change(s)`);
  return change;
}

const struggling = (over = {}) =>
  category({ completion_rate: 0.3, pace_ratio: 1.1, ...over });
const coasting = (over = {}) =>
  category({ completion_rate: 1.0, pace_ratio: 0.6, ...over });
const avoided = (over = {}) =>
  category({ pick_rate: 0.15, menu_offered_count: 6, menu_picked_count: 1, ...over });

describe("proposeTarget — the cap, against integer reality", () => {
  it("moves a target by about a quarter", () => {
    expect(proposeTarget(4, "decrease")).toBe(3);
    expect(proposeTarget(4, "increase")).toBe(5);
  });

  it("allows one whole block at a small target, where 30% alone would round to nothing", () => {
    // 3 -> 4 is +33%, past the proportional rail. Without the one-block floor
    // a 3-block category could never be adjusted in either direction.
    expect(proposeTarget(3, "increase")).toBe(4);
    expect(proposeTarget(3, "decrease")).toBe(2);
  });

  it("binds proportionally once targets are large enough for that to mean something", () => {
    expect(proposeTarget(10, "increase")).toBe(13);
    expect(proposeTarget(10, "decrease")).toBe(8);
    // 13/10 is exactly 1.3 and 8/10 is 0.8 — both inside the rail the SQL
    // side enforces on the same numbers.
    expect(proposeTarget(20, "increase")).toBeLessThanOrEqual(26);
    expect(proposeTarget(20, "decrease")).toBeGreaterThanOrEqual(14);
  });

  it("never proposes below one — stopping a category is a decision, not a nudge", () => {
    expect(proposeTarget(1, "decrease")).toBe(1);
  });
});

describe("buildWeeklyProposal", () => {
  it("proposes a reduction for a struggling category", () => {
    const cat = struggling();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.changes).toHaveLength(1);
    expect(only(proposal.changes)).toMatchObject({
      change_type: "weekly_target_blocks",
      signal: "struggling",
      old_value: 4,
      new_value: 3,
    });
  });

  it("builds a reason from the real numbers, naming both weeks", () => {
    const cur = struggling({ done_count: 1, picked_count: 4, completion_rate: 0.25 });
    const prev = struggling({ done_count: 2, picked_count: 6, completion_rate: 0.3333 });
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cur]),
      previous: week("2026-W35", [prev]),
    });
    const reason = only(proposal.changes).reason;
    expect(reason).toContain("1 of 4 tasks");
    expect(reason).toContain("25%");
    expect(reason).toContain("2 of 6 tasks");
    expect(reason).toContain("33%");
    expect(reason).toContain("under half both weeks");
  });

  it("names the overrun, in percent, when the pace arm fires", () => {
    const cat = struggling({ completion_rate: 0.95, pace_ratio: 1.5 });
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(only(proposal.changes).reason).toContain("50% longer than estimated");
  });

  it("proposes an increase for a coasting category", () => {
    const cat = coasting();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(only(proposal.changes)).toMatchObject({
      signal: "coasting",
      old_value: 4,
      new_value: 5,
    });
  });

  it("proposes a flagged question — never a number — for an avoided category", () => {
    const cat = avoided();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(only(proposal.changes)).toMatchObject({
      change_type: "flag_question",
      signal: "avoided",
      old_value: null,
      new_value: null,
    });
    expect(only(proposal.changes).reason).toContain("still a priority?");
  });

  // The other side of the seed fixture's contract. 13_weekly_performance.sql
  // asserts that weekly_performance() computes exactly these numbers for
  // `system_design` (assertions 7-7g); this asserts that those numbers, fed
  // to the engine unchanged, actually reach weekly_plan_changes as a flagged
  // question. Neither suite alone catches a signal that classifies correctly
  // and is then dropped on the way to a row, because each stops at the seam.
  //
  // Every field below is the fixture's real output, not a rounded retelling:
  // a low-but-NON-ZERO pick rate in both trailing weeks, perfect completion,
  // and an unremarkable pace -- the shape that proves avoided is about
  // engagement rather than failure. If avoided ever stopped firing here, the
  // category would fall through to on_track and produce NO change row at all
  // while every other category kept working, which is exactly how this would
  // reach a user: silently.
  it("turns the seed fixture's real system_design numbers into a flagged question", () => {
    const sysd = (pickRate: number, offered: number) =>
      category({
        category_id: "cat-sysd",
        name: "system_design",
        label: "System Design",
        days_per_week: 2,
        current_target: 2,
        picked_count: 1,
        done_count: 1,
        completion_rate: 1.0,
        pace_ratio: 1.0,
        menu_offered_count: offered,
        menu_picked_count: 1,
        pick_rate: pickRate,
      });

    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [sysd(0.1667, 6)]),
      previous: week("2026-W35", [sysd(0.2, 5)]),
    });

    expect(proposal.outcomes[0]?.classification).toBe("avoided");
    expect(proposal.changes).toHaveLength(1);
    expect(only(proposal.changes)).toMatchObject({
      change_type: "flag_question",
      target_category_id: "cat-sysd",
      signal: "avoided",
      old_value: null,
      new_value: null,
    });
    // The reason quotes the real counts, so a user can check it on their board.
    expect(only(proposal.changes).reason).toContain("1 of 6");
    expect(only(proposal.changes).reason).toContain("1 of 5");
    expect(only(proposal.changes).reason).toContain("System Design");
  });

  it("proposes nothing for a category that is on track", () => {
    const cat = category();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.outcomes[0]?.classification).toBe("on_track");
  });
});

describe("buildWeeklyProposal — the hard constraints", () => {
  it("withholds every increase in a week the plan's overall completion was below the floor", () => {
    const cat = coasting();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat], { completion_rate: 0.2 }),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.increasesSuppressed).toBe(true);
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.outcomes[0]?.suppressed).toBe("low_completion_week");
  });

  it("does NOT withhold at exactly the floor — the threshold is exclusive", () => {
    const cat = coasting();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat], { completion_rate: 0.4 }),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.increasesSuppressed).toBe(false);
    expect(proposal.changes).toHaveLength(1);
  });

  it("treats a week where nothing was picked at all as below the floor", () => {
    const cat = coasting();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat], { completion_rate: null, picked_count: 0 }),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.increasesSuppressed).toBe(true);
  });

  it("still allows a DECREASE after a bad week — easing off is always permitted", () => {
    const cat = struggling();
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat], { completion_rate: 0.1 }),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.increasesSuppressed).toBe(true);
    expect(proposal.changes).toHaveLength(1);
    expect(only(proposal.changes).new_value).toBe(3);
  });

  it("suppresses an increase in an UNRELATED category after a bad overall week", () => {
    // The category with apparent spare capacity is very often the one the
    // user retreated into while avoiding the hard one.
    const easy = coasting({ category_id: "easy", label: "SQL" });
    const hard = struggling({ category_id: "hard", label: "DSA" });
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [easy, hard], { completion_rate: 0.25 }),
      previous: week("2026-W35", [easy, hard]),
    });
    expect(proposal.changes.map((c) => c.signal)).toEqual(["struggling"]);
  });

  it("never emits a change that exceeds the rail the SQL side enforces", () => {
    for (const base of [1, 2, 3, 4, 5, 7, 10, 20, 50]) {
      for (const dir of ["increase", "decrease"] as const) {
        const next = proposeTarget(base, dir);
        const delta = Math.abs(next - base);
        const ratio = next / base;
        const withinRail = delta <= 1 || (ratio >= 0.7 && ratio <= 1.3);
        expect(withinRail, `base ${base} ${dir} -> ${next}`).toBe(true);
        expect(next).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("proposes nothing rather than a no-op when a target cannot move", () => {
    // A target of 1 cannot be eased further. A 1 -> 1 row is noise the user
    // has to read and dismiss.
    const cat = struggling({ current_target: 1, days_per_week: 1 });
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [cat]),
      previous: week("2026-W35", [cat]),
    });
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.outcomes[0]?.suppressed).toBe("capped_to_no_change");
    // The classification is still reported, so the Review deck can say "we
    // noticed, there is nothing to adjust" rather than saying nothing.
    expect(proposal.outcomes[0]?.classification).toBe("struggling");
  });
});

describe("buildWeeklyProposal — thin data", () => {
  it("proposes nothing on a plan's first-ever review, and does not throw", () => {
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [struggling(), coasting({ category_id: "c2" })]),
    });
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.outcomes.every((o) => o.classification === "insufficient_data")).toBe(true);
  });

  it("excludes a just-added category while still proposing for its older siblings", () => {
    const fresh = coasting({
      category_id: "fresh",
      label: "Fresh",
      existed_before_week: false,
    });
    const old = coasting({ category_id: "old", label: "Old" });
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", [fresh, old]),
      previous: week("2026-W35", [fresh, old]),
    });
    expect(proposal.changes).toHaveLength(1);
    expect(only(proposal.changes).target_category_id).toBe("old");
    expect(
      proposal.outcomes.find((o) => o.category_id === "fresh")?.classification,
    ).toBe("insufficient_data");
  });

  it("reports an outcome for every category, whether or not it produced a change", () => {
    const cats = [
      struggling({ category_id: "a" }),
      coasting({ category_id: "b" }),
      avoided({ category_id: "c" }),
      category({ category_id: "d" }),
    ];
    const proposal = buildWeeklyProposal({
      current: week("2026-W36", cats),
      previous: week("2026-W35", cats),
    });
    expect(proposal.outcomes).toHaveLength(4);
    expect(proposal.outcomes.map((o) => o.classification)).toEqual([
      "struggling",
      "coasting",
      "avoided",
      "on_track",
    ]);
  });
});
