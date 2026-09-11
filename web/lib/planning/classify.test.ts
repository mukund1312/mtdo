import { describe, expect, it } from "vitest";
import { classifyCategory } from "./classify";
import { category } from "./fixtures";

// Boundary correctness is the whole game for a rules engine: a threshold that
// is off by one comparison operator silently reclassifies real users, and
// nothing else in the system would notice. Every threshold is therefore
// tested AT the value and one step either side of it.

describe("classifyCategory — struggling", () => {
  it("fires when completion is under half in both weeks", () => {
    const w = category({ completion_rate: 0.33 });
    expect(classifyCategory(w, w)).toBe("struggling");
  });

  it("does NOT fire at exactly 0.5 — at exactly half, the plan is not proven too heavy", () => {
    const w = category({ completion_rate: 0.5 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("fires just below 0.5", () => {
    const w = category({ completion_rate: 0.4999 });
    expect(classifyCategory(w, w)).toBe("struggling");
  });

  it("does NOT fire on a single bad week — noise must not rewrite a plan", () => {
    const good = category({ completion_rate: 0.8 });
    const bad = category({ completion_rate: 0.2 });
    expect(classifyCategory(good, bad)).toBe("on_track");
    expect(classifyCategory(bad, good)).toBe("on_track");
  });

  it("fires on pace alone when tasks consistently run over", () => {
    const w = category({ pace_ratio: 1.6 });
    expect(classifyCategory(w, w)).toBe("struggling");
  });

  it("does NOT fire at exactly 1.3 pace", () => {
    const w = category({ pace_ratio: 1.3 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("fires just above 1.3 pace", () => {
    const w = category({ pace_ratio: 1.3001 });
    expect(classifyCategory(w, w)).toBe("struggling");
  });

  it("does not mix arms across weeks — a slow week plus a low-completion week is two bad weeks, not one signal", () => {
    const slow = category({ completion_rate: 0.8, pace_ratio: 1.8 });
    const unfinished = category({ completion_rate: 0.2, pace_ratio: 1.0 });
    expect(classifyCategory(slow, unfinished)).toBe("on_track");
  });
});

describe("classifyCategory — coasting", () => {
  it("fires on near-perfect completion finished well under estimate", () => {
    const w = category({ completion_rate: 1.0, pace_ratio: 0.6 });
    expect(classifyCategory(w, w)).toBe("coasting");
  });

  it("fires at exactly 0.9 completion — the threshold is inclusive", () => {
    const w = category({ completion_rate: 0.9, pace_ratio: 0.6 });
    expect(classifyCategory(w, w)).toBe("coasting");
  });

  it("does NOT fire just below 0.9 completion", () => {
    const w = category({ completion_rate: 0.8999, pace_ratio: 0.6 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("does NOT fire at exactly 0.7 pace — the threshold is exclusive", () => {
    const w = category({ completion_rate: 1.0, pace_ratio: 0.7 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("fires just below 0.7 pace", () => {
    const w = category({ completion_rate: 1.0, pace_ratio: 0.6999 });
    expect(classifyCategory(w, w)).toBe("coasting");
  });

  it("needs BOTH arms — finishing everything at a normal pace is just a good week", () => {
    const w = category({ completion_rate: 1.0, pace_ratio: 1.0 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("needs BOTH arms — fast work with half the tasks dropped is triage, not spare capacity", () => {
    const w = category({ completion_rate: 0.5, pace_ratio: 0.4 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("never fires when pace is uncomputable, rather than treating null as fast", () => {
    const w = category({ completion_rate: 1.0, pace_ratio: null, paced_task_count: 0 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });
});

describe("classifyCategory — avoided", () => {
  it("fires when the menu keeps offering and the user keeps not picking", () => {
    const w = category({ pick_rate: 0.15, menu_offered_count: 6, menu_picked_count: 1 });
    expect(classifyCategory(w, w)).toBe("avoided");
  });

  it("does NOT fire at exactly 0.3 — a question on thin evidence is worse than silence", () => {
    const w = category({ pick_rate: 0.3 });
    expect(classifyCategory(w, w)).toBe("on_track");
  });

  it("fires just below 0.3", () => {
    const w = category({ pick_rate: 0.2999 });
    expect(classifyCategory(w, w)).toBe("avoided");
  });

  it("is about engagement, not failure — it fires even when everything picked was finished", () => {
    const w = category({ pick_rate: 0.17, completion_rate: 1.0, pace_ratio: 1.0 });
    expect(classifyCategory(w, w)).toBe("avoided");
  });

  it("takes precedence over struggling — the target was never the obstacle", () => {
    // Picks almost nothing AND fails what little it picks. Easing the weekly
    // target would answer a question this user never asked.
    const w = category({ pick_rate: 0.1, completion_rate: 0.2, pace_ratio: 1.9 });
    expect(classifyCategory(w, w)).toBe("avoided");
  });
});

describe("classifyCategory — the data gaps that must not read as health", () => {
  it("reports insufficient_data for a plan's first-ever review, not on_track", () => {
    expect(classifyCategory(undefined, category({ completion_rate: 0.2 }))).toBe(
      "insufficient_data",
    );
  });

  it("excludes a category that did not exist for the whole week under review", () => {
    const fresh = category({ existed_before_week: false, completion_rate: 0.1 });
    expect(classifyCategory(fresh, fresh)).toBe("insufficient_data");
  });

  it("excludes a category that was missing from the earlier week entirely", () => {
    expect(classifyCategory(undefined, category())).toBe("insufficient_data");
  });

  it("excludes a week where nothing was offered AND nothing was picked", () => {
    const silent = category({
      menu_offered_count: 0,
      menu_picked_count: 0,
      picked_count: 0,
      completion_rate: null,
      pick_rate: null,
      pace_ratio: null,
    });
    expect(classifyCategory(silent, silent)).toBe("insufficient_data");
  });

  it("does NOT exclude a week where things were offered and none were picked — that is real behaviour", () => {
    const ignored = category({
      menu_offered_count: 8,
      menu_picked_count: 0,
      picked_count: 0,
      completion_rate: null,
      pick_rate: 0,
      pace_ratio: null,
    });
    // Offered eight, picked none: pick_rate 0 is a real measurement, and this
    // is exactly what the avoided signal exists to catch.
    expect(classifyCategory(ignored, ignored)).toBe("avoided");
  });

  it("never reads a null completion_rate as zero", () => {
    // Nothing picked: completion_rate is null. If this were coalesced to 0 it
    // would classify as struggling and cut the target of a category the user
    // simply never opened.
    const w = category({
      picked_count: 0,
      done_count: 0,
      completion_rate: null,
      pace_ratio: null,
      menu_offered_count: 5,
      menu_picked_count: 0,
      pick_rate: 0.8, // high pick_rate so `avoided` is not what answers this
    });
    expect(classifyCategory(w, w)).toBe("on_track");
  });
});
