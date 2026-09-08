// The provider-neutral seam Phase 2 introduces (docs/architecture/api.md §2,
// the operating-engine plan's Phase 2). Anthropic stays the deployed
// default; Ollama is for local dev / self-host. Nothing outside
// web/lib/ai/service.ts should import a concrete provider directly --
// service.ts is the only thing that picks one.

export type StreamTextOptions = {
  /** Forwarded straight through to the underlying HTTP/SDK call so a client
   * disconnect cancels generation instead of running to completion with
   * nowhere for the output to go (see onboarding/plan/route.ts's header
   * comment on why this matters for a Route Handler's own lifecycle). */
  maxTokens: number;
  onDelta: (text: string) => void;
  prompt: string;
  signal?: AbortSignal;
};

export type GenerateTextOptions = {
  maxTokens: number;
  prompt: string;
  signal?: AbortSignal;
};

export interface AIProvider {
  /** Short, stable identifier -- used for the /api/ai/status response and
   * for service.ts's "don't fall back to the provider that already just
   * failed" check. Never shown to an end user as-is. */
  readonly id: string;

  /** Non-streaming completion. */
  generateText(options: GenerateTextOptions): Promise<string>;

  /** Whether the provider is currently reachable and configured correctly
   * (network + auth for Anthropic; the local daemon being up for Ollama).
   * Never throws -- a provider that can't be reached is a `false`, not an
   * exception, so callers can use it as a plain boolean gate. */
  healthCheck(): Promise<boolean>;

  /** Model ids currently available through this provider (installed local
   * models for Ollama; the fixed deployed set for Anthropic). */
  listModels(): Promise<string[]>;

  /** Streaming completion. Resolves with the full accumulated text once the
   * stream ends; `onDelta` fires once per chunk as it arrives, in order,
   * before the promise resolves -- callers that need a live "still
   * generating" UI (onboarding's ndjson deltas) read from `onDelta`, callers
   * that only need the final text (most of Phase 7/8's domain methods) can
   * ignore it and just await the return value. */
  streamText(options: StreamTextOptions): Promise<string>;
}
