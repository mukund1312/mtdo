import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PWA manifest lives in app/manifest.ts (Next.js App Router convention);
  // no plugin needed for the manifest itself. Service-worker/installability
  // wiring is a separate W0 task once an icon set exists.
};

export default nextConfig;
