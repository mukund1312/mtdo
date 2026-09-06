"use client";

import { useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { submitFeedback } from "@/lib/feedback";
import styles from "./FeedbackWidget.module.css";

type WidgetState = "closed" | "open" | "sending" | "sent" | "error";

// Global entry point for the feedback table (schema.md, migrations/0003) --
// rendered once from app/layout.tsx (task #8: submitFeedback() has existed
// since W2 with zero UI call sites anywhere in the app). Deliberately a
// small floating control, not a per-screen form: feedback needs to be
// reachable from anywhere, and DESIGN.md's minimal/no-gamification ethos
// rules out anything louder than this.
export function FeedbackWidget() {
  const pathname = usePathname();
  const [state, setState] = useState<WidgetState>("closed");
  const [message, setMessage] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  // DESIGN.md, Component Notes: the session screen is "the highest-focus
  // surface in the product... nothing else on screen." A floating widget
  // there would violate that on every visit, not just while open.
  const isFocusSurface = pathname === "/session";

  const open = useCallback(() => {
    setState("open");
    setErrorText(null);
  }, []);

  const close = useCallback(() => {
    setState("closed");
    setMessage("");
    setErrorText(null);
  }, []);

  const submit = useCallback(async () => {
    if (!message.trim()) return;
    setState("sending");
    try {
      await submitFeedback(createClient(), { screen: pathname, message });
      setState("sent");
      setMessage("");
      // Auto-close shortly after a successful send -- the confirmation
      // itself is the only feedback the user needs; nothing to review.
      window.setTimeout(() => setState("closed"), 1800);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setState("error");
    }
  }, [message, pathname]);

  if (isFocusSurface) return null;

  if (state === "closed") {
    return (
      <button type="button" className={styles.trigger} onClick={open} aria-label="Send feedback">
        Feedback
      </button>
    );
  }

  if (state === "sent") {
    return (
      <div className={styles.panel} role="status">
        <p className={styles.sentNote}>Thanks — that is on its way.</p>
      </div>
    );
  }

  const sending = state === "sending";

  return (
    <div className={styles.panel} role="dialog" aria-modal="false" aria-label="Send feedback">
      <div className={styles.panelHead}>
        <span>Feedback</span>
        <button type="button" className={styles.closeButton} onClick={close} aria-label="Close feedback form">
          ×
        </button>
      </div>
      <textarea
        className={styles.textarea}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="What's working, what isn't -- anything."
        maxLength={4096}
        disabled={sending}
        autoFocus
      />
      {state === "error" && errorText && <p className={styles.errorNote}>{errorText}</p>}
      <button
        type="button"
        className={styles.sendButton}
        onClick={() => void submit()}
        disabled={sending || !message.trim()}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
