import type { Metadata, Viewport } from "next";
import "./styles/tokens.css";
import "./globals.css";

// Satoshi via Fontshare, per DESIGN.md §Typography — one family across the
// whole product, body at 300 weight, no monospace in the interface.
const SATOSHI_HREF =
  "https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700,900&display=swap";

export const metadata: Metadata = {
  title: "mtdo",
  description:
    "Plan a goal, get coached through it, and prove you moved — mtdo is where serious learners keep going.",
};

export const viewport: Viewport = {
  themeColor: "#0b0b0c",
};

// Conflict-prevention rule (docs/architecture/decisions.md): this file is
// owned by one agent only. Every other wave adds routes/components, never
// edits this layout directly.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="no-js">
      <head>
        <link rel="stylesheet" href={SATOSHI_HREF} />
        {/*
          No-JS fallback (DESIGN.md §Accessibility): remove `no-js` the
          instant JS runs, before any reveal-gated content would otherwise
          render blank. Inline and synchronous on purpose — this must not
          wait on a bundle.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.classList.remove('no-js')",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
