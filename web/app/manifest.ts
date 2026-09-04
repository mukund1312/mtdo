import type { MetadataRoute } from "next";

// PWA manifest — "add to home screen" is a W0 verification criterion
// (docs/architecture, delivery plan §5). Icon files referenced below don't
// exist yet: real brand icon assets (192x192, 512x512 PNG, plus a favicon)
// are a manual design step, not something to fabricate here. Add them to
// web/app/icon-192.png and web/app/icon-512.png before this manifest is
// functionally complete — Next.js will 404 on the icon URLs until then.
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
