"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "../signal-deck.css";
import "./settings.css";

type AIStatus = { models: string[]; provider: string; reachable: boolean };
type LoadState = "loading" | "ready" | "error";

// Settings -> AI (Phase 2 of the operating-engine plan). The rest of
// Settings (Plan & Data, Integrations, Preferences, Record, Account, Help)
// is Phase 8's "More" surface -- this page is deliberately just the one
// section Phase 2 actually built a backend for, not a stand-in for the
// whole thing.
export default function SignalDeckSettingsPage() {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/ai/status");
      if (!response.ok) {
        setState("error");
        return;
      }
      setStatus((await response.json()) as AIStatus);
      setState("ready");
    } catch (err) {
      console.error("[settings] failed to load AI status:", err);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="a02-shell a02-settings">
      <div className="a02-view-head">
        <div>
          <span className="a02-eyebrow">SETTINGS</span>
          <h1>
            Under the
            <br />
            <em>hood.</em>
          </h1>
        </div>
        <Link href="/architecture-02" className="a02-settings-back">
          ← Back to deck
        </Link>
      </div>

      <section className="a02-product-state a02-settings-card" aria-labelledby="ai-settings-title">
        <b id="ai-settings-title">AI provider</b>
        {state === "loading" && <p>Checking the configured provider…</p>}
        {state === "error" && (
          <>
            <p>Could not read the AI provider&apos;s status.</p>
            <button type="button" onClick={() => void load()}>
              Try again ↗
            </button>
          </>
        )}
        {state === "ready" && status && (
          <div className="a02-settings-status">
            <div className="a02-settings-row">
              <span>Provider</span>
              <strong>{status.provider}</strong>
            </div>
            <div className="a02-settings-row">
              <span>Status</span>
              <strong className={status.reachable ? "is-ok" : "is-down"}>
                <i aria-hidden="true" /> {status.reachable ? "Reachable" : "Unreachable"}
              </strong>
            </div>
            <div className="a02-settings-row">
              <span>Models</span>
              <strong>{status.models.length > 0 ? status.models.join(", ") : "none reported"}</strong>
            </div>
          </div>
        )}
        <p className="a02-settings-note">
          The provider is set on the server (<code>AI_PROVIDER</code>) -- there is no per-user
          switch here yet. Self-hosting with Ollama: point <code>OLLAMA_ENDPOINT</code> at a
          running daemon; a failed health check falls back to Anthropic automatically.
        </p>
      </section>
    </main>
  );
}
