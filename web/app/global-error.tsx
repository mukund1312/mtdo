"use client";

import { useEffect } from "react";

// Next.js App Router convention: this is the one error boundary that can
// catch an error thrown by the root layout itself, which is why it must
// render its own <html>/<body> rather than relying on layout.tsx (a thrown
// root layout means layout.tsx never rendered). Reports to Sentry when
// configured; degrades to a plain reload prompt when it isn't -- matches
// the project's standing failure contract (an unconfigured integration
// never blocks or complicates the fallback UI).
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    void import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error));
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          background: "#0B0B0C",
          color: "#FAFAFA",
          fontFamily: "system-ui, sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <p style={{ color: "#8A8A93", fontSize: "14px" }}>Something went wrong.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,.09)",
            borderRadius: "999px",
            color: "#FAFAFA",
            padding: "10px 20px",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
