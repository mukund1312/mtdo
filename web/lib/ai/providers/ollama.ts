// Local-model provider for dev / self-host, behind the same AIProvider seam
// as Anthropic (Phase 2). Talks to a local Ollama daemon's HTTP API --
// https://github.com/ollama/ollama/blob/main/docs/api.md -- no SDK
// dependency (this repo has been burned twice by dependency version
// conflicts, decisions.md, TS 7 / ESLint 10; a provider this small isn't
// worth adding one for).
import type { AIProvider, GenerateTextOptions, StreamTextOptions } from "../provider";

type OllamaChatChunk = {
  done: boolean;
  message?: { content: string };
};

type OllamaTagsResponse = {
  models?: Array<{ model: string }>;
};

export class OllamaProvider implements AIProvider {
  readonly id = "ollama";

  private readonly endpoint: string;
  private readonly model: string;

  constructor(endpoint: string, model: string) {
    // Trailing slash normalized once here so every call site below can do
    // plain string concatenation without re-checking it.
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.model = model;
  }

  private async chat(prompt: string, stream: boolean, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.endpoint}/api/chat`, {
      body: JSON.stringify({
        format: "json",
        messages: [{ content: prompt, role: "user" }],
        model: this.model,
        stream,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    });
  }

  async generateText({ prompt, signal }: GenerateTextOptions): Promise<string> {
    const response = await this.chat(prompt, false, signal);
    if (!response.ok) {
      throw new Error(`Ollama /api/chat returned ${response.status}`);
    }
    const body = (await response.json()) as OllamaChatChunk;
    return body.message?.content ?? "";
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/version`, {
        // A hung local daemon must not hold an onboarding request open for
        // the Route Handler's full maxDuration -- fail fast so service.ts's
        // fall-through to Anthropic actually happens promptly.
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return [];
      const body = (await response.json()) as OllamaTagsResponse;
      return (body.models ?? []).map((entry) => entry.model);
    } catch {
      return [];
    }
  }

  async streamText({ onDelta, prompt, signal }: StreamTextOptions): Promise<string> {
    const response = await this.chat(prompt, true, signal);
    if (!response.ok || !response.body) {
      throw new Error(`Ollama /api/chat returned ${response.status}`);
    }
    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      // Ollama's streaming response is newline-delimited JSON, one object
      // per line -- same shape this app's own ndjson output uses.
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        const delta = chunk.message?.content ?? "";
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      }
    }
    return fullText;
  }
}
