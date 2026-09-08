// Wraps @anthropic-ai/sdk behind the AIProvider seam. This is the exact call
// shape route.ts used inline before Phase 2 -- moved, not changed, so the
// route's own regression tests (mocking "@anthropic-ai/sdk" at the module
// level) keep passing unchanged through the extra layer of indirection.
import Anthropic from "@anthropic-ai/sdk";

import type { AIProvider, GenerateTextOptions, StreamTextOptions } from "../provider";

// split-plan §5: Sonnet for Route Handlers/RPC-shaped work, Opus reserved for
// schema/RLS/session-authority design.
const DEFAULT_MODEL = "claude-sonnet-5";

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";

  private client(): Anthropic {
    // Constructed per call, not cached on the instance: matches the
    // pre-refactor route.ts (`new Anthropic()` inside the request handler),
    // and keeps this provider free of any signal-carrying state between
    // unrelated requests.
    return new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  }

  async generateText({ maxTokens, prompt, signal }: GenerateTextOptions): Promise<string> {
    const message = await this.client().messages.create(
      { max_tokens: maxTokens, messages: [{ content: prompt, role: "user" }], model: DEFAULT_MODEL },
      { signal },
    );
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Anthropic has no dedicated health endpoint; a 1-token completion is
      // the standard "is the key valid and the API reachable" probe.
      await this.client().messages.create({
        max_tokens: 1,
        messages: [{ content: "ping", role: "user" }],
        model: DEFAULT_MODEL,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    // Fixed deployed set, not queried -- Anthropic's models endpoint lists
    // every model on the account's plan, most of which this app never
    // targets. Update this list when the deployed model changes, same as
    // DEFAULT_MODEL above.
    return [DEFAULT_MODEL];
  }

  async streamText({ maxTokens, onDelta, prompt, signal }: StreamTextOptions): Promise<string> {
    let fullText = "";
    const messageStream = this.client().messages.stream(
      { max_tokens: maxTokens, messages: [{ content: prompt, role: "user" }], model: DEFAULT_MODEL },
      { signal },
    );
    messageStream.on("text", (delta) => {
      fullText += delta;
      onDelta(delta);
    });
    await messageStream.finalMessage();
    return fullText;
  }
}
