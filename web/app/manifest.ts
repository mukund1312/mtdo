import type { MetadataRoute } from "next";

// PWA manifest — "add to home screen" is a W0 verification criterion
// (docs/architecture, delivery plan §5). public/icon-192.png and
// public/icon-512.png are a placeholder (dark --bg square, the same
// ring-and-dot mark as the marketing header's <Mark /> component) so the
// manifest doesn't 404 -- swap them for a fuller designed brand treatment
// whenever that becomes its own piece of work; nothing here depends on the
// glyph staying this simple.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "mtdo",
    short_name: "mtdo",
    description:
      "Plan a goal, get coached through it, and prove you moved.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b0c",
    theme_color: "#0b0b0c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
