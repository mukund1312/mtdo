import type { Metadata, Viewport } from "next";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import { SignalDeckListenProvider } from "@/app/(marketing)/architecture-02/listen-state";
import { SignalDeckThemeProvider } from "@/app/(marketing)/architecture-02/theme-preference";
import "./styles/tokens.css";
import "./styles/signal-deck-light.css";
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href={SATOSHI_HREF} />
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var t=localStorage.getItem('mtdo-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.a02Theme=t;document.documentElement.style.colorScheme=t}}catch(e){}",
          }}
        />
      </head>
      <body>
        <SignalDeckThemeProvider><SignalDeckListenProvider>{children}</SignalDeckListenProvider></SignalDeckThemeProvider>
        <FeedbackWidget />
      </body>
    </html>
  );
}
