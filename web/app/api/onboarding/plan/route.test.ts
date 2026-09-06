// Tests for the onboarding plan-generation Route Handler (see route.ts's own
// header comment for the documented contract this exercises). Mocks the
// Anthropic SDK, the Supabase server client, persistGeneratedPlan, and
// recordEvent -- everything else (buildPlanPrompt, parseGeneratedPlan,
// buildFallbackPlan) runs for real, so these tests exercise the actual
// parsing/fallback branching the route depends on, not a stubbed-out
// version of it.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OnboardingAnswers } from "@/lib/plan-generation/types";
import type { PersistedPlanSummary } from "@/lib/plan-generation/persist";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

const { mockPersist } = vi.hoisted(() => ({ mockPersist: vi.fn() }));
vi.mock("@/lib/plan-generation/persist", () => ({
  persistGeneratedPlan: mockPersist,
}));

const { mockRecordEvent } = vi.hoisted(() => ({ mockRecordEvent: vi.fn() }));
vi.mock("@/lib/analytics/record-event", () => ({
  recordEvent: mockRecordEvent,
}));

const { mockStreamCtor } = vi.hoisted(() => ({ mockStreamCtor: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: mockStreamCtor };
  },
}));

// Imported after the mocks above are registered (vi.mock is hoisted by
// Vitest above imports regardless of source order, but importing route.ts
// itself must still come after this file's other setup runs).
const { POST } = await import("./route");

/** A minimal stand-in for the Anthropic SDK's MessageStream: registers the
 * "text" handler .on() attaches, then replays `deltas` through it and either
 * resolves or rejects when finalMessage() is awaited -- matching how route.ts
 * only ever calls .on("text", ...) once and awaits .finalMessage() once. */
function fakeMessageStream({ deltas = [], finalError }: { deltas?: string[]; finalError?: unknown }) {
  let textHandler: ((delta: string) => void) | undefined;
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") textHandler = cb;
      return this;
    },
    async finalMessage() {
      for (const d of deltas) textHandler?.(d);
      if (finalError) throw finalError;
      return {};
    },
  };
}

function validAnswers(overrides: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    goalLine: "Get better at backend interviews.",
    focusAreas: ["Backend"],
    experienceLevel: "intermediate",
    weeklyDaysAvailable: [0, 2, 4],
    ...overrides,
  };
}

/** A minimal but schema-valid raw model response (matches parse.ts's rules:
 * snake_case name, curriculum length == days.length * 2). */
function generatedPlanJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app_name: "Interview Route",
    goal_line: "Become confident with backend interviews.",
    categories: [
      {
        name: "backend_foundations",
        label: "Backend Foundations",
        days: [0],
        min_blocks: 1,
        score_weight: 100,
        curriculum: [["Task one."], ["Task two."]],
      },
    ],
    ...overrides,
  });
}

function makeRequest(body: unknown, opts: { signal?: AbortSignal } = {}): Request {
  return new Request("http://localhost/api/onboarding/plan", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts.signal,
  });
}

/** Drains a route response's ndjson body into parsed objects. Only safe to
 * call on a response whose stream actually closes (every branch except the
 * client-disconnect/abort branch, which deliberately never calls
 * controller.close() -- see route.ts's comment there). */
async function readNdjson(response: Response): Promise<unknown[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

const AUTHED_USER = { id: "user-123" };

const PERSISTED_SUMMARY: PersistedPlanSummary = {
  planId: "plan-1",
  appName: "Interview Route",
  goalLine: "Become confident with backend interviews.",
  categories: [{ id: "cat-1", name: "backend_foundations", label: "Backend Foundations" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: AUTHED_USER }, error: null });
  mockPersist.mockResolvedValue(PERSISTED_SUMMARY);
  mockRecordEvent.mockResolvedValue(true);
});

describe("POST /api/onboarding/plan -- request validation", () => {
  it("400s on a body that isn't valid JSON", async () => {
    const response = await POST(makeRequest("not json"));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/must be JSON/);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("400s when required fields are missing entirely", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/Invalid onboarding answers/);
  });

  it("400s when focusAreas has more than 6 entries", async () => {
    const response = await POST(
      makeRequest(validAnswers({ focusAreas: ["a", "b", "c", "d", "e", "f", "g"] })),
    );
    expect(response.status).toBe(400);
  });

  it("400s on an out-of-range weeklyDaysAvailable value", async () => {
    const response = await POST(makeRequest(validAnswers({ weeklyDaysAvailable: [7] })));
    expect(response.status).toBe(400);
  });

  it("400s on an invalid experienceLevel", async () => {
    const response = await POST(
      makeRequest({ ...validAnswers(), experienceLevel: "expert" }),
    );
    expect(response.status).toBe(400);
  });

  it("does not touch auth or Anthropic when validation fails", async () => {
    await POST(makeRequest({}));
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockStreamCtor).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/plan -- auth", () => {
  it("401s when there is no authenticated user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await POST(makeRequest(validAnswers()));
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toMatch(/No authenticated session/);
    expect(mockStreamCtor).not.toHaveBeenCalled();
  });

  it("401s when getUser itself returns an error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error("expired") });
    const response = await POST(makeRequest(validAnswers()));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/onboarding/plan -- happy path", () => {
  it("streams deltas then a done event with the persisted plan, and records plan_generated", async () => {
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({ deltas: [generatedPlanJson()] }),
    );

    const response = await POST(makeRequest(validAnswers()));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/x-ndjson/);

    const events = await readNdjson(response);
    expect(events[0]).toEqual({ type: "delta", text: generatedPlanJson() });
    expect(events[events.length - 1]).toEqual({
      type: "done",
      usedFallback: false,
      plan: PERSISTED_SUMMARY,
    });

    expect(mockPersist).toHaveBeenCalledTimes(1);
    const call = mockPersist.mock.calls[0]!;
    const [, userId, persistedPlan] = call;
    expect(userId).toBe(AUTHED_USER.id);
    expect(persistedPlan.categories[0].name).toBe("backend_foundations");

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "plan_generated",
      { usedFallback: false, categoryCount: 1 },
    );
  });

  it("passes the Anthropic call's own AbortSignal through from the request", async () => {
    mockStreamCtor.mockReturnValue(fakeMessageStream({ deltas: [generatedPlanJson()] }));
    const request = makeRequest(validAnswers());

    await readNdjson(await POST(request));

    expect(mockStreamCtor).toHaveBeenCalledTimes(1);
    const [, streamOpts] = mockStreamCtor.mock.calls[0]!;
    expect(streamOpts.signal).toBe(request.signal);
  });
});

describe("POST /api/onboarding/plan -- falls back to the static plan", () => {
  it("falls back when the Anthropic call itself fails", async () => {
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({ deltas: [], finalError: new Error("network blip") }),
    );

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);

    const done = events[events.length - 1] as { type: string; usedFallback: boolean };
    expect(done).toMatchObject({ type: "done", usedFallback: true });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "plan_generated",
      expect.objectContaining({ usedFallback: true }),
    );
    // Fallback plan was actually what got persisted, not the (empty/garbage) model output.
    const [, , persistedPlan] = mockPersist.mock.calls[0]!;
    expect(persistedPlan.categories.map((c: { name: string }) => c.name)).toContain("core_practice");
  });

  it("falls back when the model's response doesn't parse into a valid plan", async () => {
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({ deltas: ["this is not json at all"] }),
    );

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);

    const done = events[events.length - 1] as { type: string; usedFallback: boolean };
    expect(done).toMatchObject({ type: "done", usedFallback: true });
  });

  it("falls back when the model's plan has a duplicate category name", async () => {
    const category = JSON.parse(generatedPlanJson()).categories[0];
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({
        deltas: [generatedPlanJson({ categories: [category, category] })],
      }),
    );

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);
    const done = events[events.length - 1] as { type: string; usedFallback: boolean };
    expect(done).toMatchObject({ usedFallback: true });
  });
});

describe("POST /api/onboarding/plan -- persistence failures", () => {
  it("retries with the fallback plan once when persisting the generated plan fails", async () => {
    mockStreamCtor.mockReturnValue(fakeMessageStream({ deltas: [generatedPlanJson()] }));
    mockPersist
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce(PERSISTED_SUMMARY);

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);

    expect(mockPersist).toHaveBeenCalledTimes(2);
    const done = events[events.length - 1] as { type: string; usedFallback: boolean };
    expect(done).toMatchObject({ type: "done", usedFallback: true });
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "plan_generated",
      expect.objectContaining({ usedFallback: true }),
    );
  });

  it("emits an error event when the generated plan AND its fallback both fail to persist", async () => {
    mockStreamCtor.mockReturnValue(fakeMessageStream({ deltas: [generatedPlanJson()] }));
    mockPersist.mockRejectedValue(new Error("db unavailable"));

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);

    expect(events[events.length - 1]).toEqual({
      type: "error",
      message: "Couldn't save a plan. Please try again.",
    });
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("does not retry a fallback that has already used the fallback plan (avoids double persistence)", async () => {
    // Anthropic itself fails -> fallback plan built -> persisting THAT also
    // fails -> route.ts's `if (!usedFallback)` guard means it must not try
    // yet another fallback persist attempt.
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({ deltas: [], finalError: new Error("network blip") }),
    );
    mockPersist.mockRejectedValue(new Error("db unavailable"));

    const response = await POST(makeRequest(validAnswers()));
    const events = await readNdjson(response);

    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(events[events.length - 1]).toEqual({
      type: "error",
      message: "Couldn't save a plan. Please try again.",
    });
  });
});

describe("POST /api/onboarding/plan -- client disconnect", () => {
  it("emits nothing and never persists when the request was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockStreamCtor.mockReturnValue(
      fakeMessageStream({ deltas: [], finalError: new Error("aborted") }),
    );

    const response = await POST(makeRequest(validAnswers(), { signal: controller.signal }));

    // The stream deliberately never calls controller.close() on this path
    // (route.ts: "there's no one left to stream a fallback to") -- reading
    // to completion would hang, so just confirm nothing was ever emitted
    // (via consumers) and no persistence work happened.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(response.status).toBe(200); // headers are already sent before generation starts
  });
});
