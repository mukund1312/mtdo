// The one seam a UI component or Route Handler is allowed to import from
// web/lib/ai/** (Phase 2). Nothing outside this file imports a concrete
// provider directly.
//
// Provider selection is server-env-driven: AI_PROVIDER ("anthropic" |
// "ollama", default "anthropic"), OLLAMA_ENDPOINT, OLLAMA_MODEL. If
// AI_PROVIDER=ollama and its healthCheck() fails, this falls through to
// Anthropic -- the existing failure contract (CLAUDE.md: "never block the
// core loop on an external call") extends to provider selection, it does
// not change. Onboarding's further fallback to a static plan
// (lib/plan-generation/fallback.ts) still happens one layer up, in
// app/api/onboarding/plan/route.ts, if the provider selected here also
// fails to produce a parseable plan.
import type { AIProvider, StreamTextOptions } from "./provider";
import { AnthropicProvider } from "./providers/anthropic";
import { OllamaProvider } from "./providers/ollama";

const anthropicProvider = new AnthropicProvider();

function ollamaProvider(): OllamaProvider {
  return new OllamaProvider(
    process.env.OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434",
    process.env.OLLAMA_MODEL ?? "llama3.1",
  );
}

/** Resolves which provider a request should use right now. Exported for
 * /api/ai/status (Phase 2's other new route) to report the same decision
 * back to Settings -> AI without duplicating this branch. */
export async function resolveProvider(): Promise<AIProvider> {
  if (process.env.AI_PROVIDER !== "ollama") return anthropicProvider;
  const ollama = ollamaProvider();
  if (await ollama.healthCheck()) return ollama;
  console.error("[ai/service] AI_PROVIDER=ollama but the daemon is unreachable -- falling back to Anthropic.");
  return anthropicProvider;
}

/** Generates a goal plan's raw model text, streaming deltas to `onDelta` as
 * they arrive. Parsing the result into a GeneratedPlan (lib/plan-generation/
 * parse.ts) and falling back to a static plan on a parse failure both stay
 * in route.ts -- this function's only job is "get text out of whichever
 * provider is configured," not plan-shape validation. */
export async function generateGoalPlan(options: Omit<StreamTextOptions, "maxTokens">): Promise<string> {
  const provider = await resolveProvider();
  try {
    return await provider.streamText({ ...options, maxTokens: 16000 });
  } catch (err) {
    // A request the client already disconnected from has nowhere to stream
    // a second attempt to -- propagate as-is, same as the pre-Phase-2 route
    // did, and let the caller's own signal.aborted check decide what to log.
    if (options.signal?.aborted) throw err;
    if (provider.id === "anthropic") throw err;
    console.error(`[ai/service] ${provider.id} provider failed mid-stream, falling back to Anthropic:`, err);
    return await anthropicProvider.streamText({ ...options, maxTokens: 16000 });
  }
}
