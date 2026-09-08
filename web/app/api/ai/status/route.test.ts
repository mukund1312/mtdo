// Tests for GET /api/ai/status (see route.ts's own header comment for the
// contract). Mocks the Supabase server client and lib/ai/service's
// resolveProvider -- the provider implementations themselves have their own
// tests under lib/ai/.

import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

const { mockResolveProvider } = vi.hoisted(() => ({ mockResolveProvider: vi.fn() }));
vi.mock("@/lib/ai/service", () => ({
  resolveProvider: mockResolveProvider,
}));

const { GET } = await import("./route");

const AUTHED_USER = { id: "user-123" };

function fakeProvider(overrides: Partial<{ id: string; healthCheck: () => Promise<boolean>; listModels: () => Promise<string[]> }> = {}) {
  return {
    id: "anthropic",
    healthCheck: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue(["claude-sonnet-5"]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: AUTHED_USER }, error: null });
});

describe("GET /api/ai/status", () => {
  it("401s when there is no authenticated user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it("401s when getUser itself returns an error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error("boom") });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("reports the resolved provider's id, reachability and models", async () => {
    mockResolveProvider.mockResolvedValue(fakeProvider());
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      models: ["claude-sonnet-5"],
      provider: "anthropic",
      reachable: true,
    });
  });

  it("reports an unreachable provider as such rather than erroring", async () => {
    mockResolveProvider.mockResolvedValue(
      fakeProvider({ id: "ollama", healthCheck: vi.fn().mockResolvedValue(false), listModels: vi.fn().mockResolvedValue([]) }),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [], provider: "ollama", reachable: false });
  });
});
