// Mirrors tsconfig.json's "@/*" -> "./*" path alias for Vitest, which does
// not read tsconfig paths on its own. Without this, any module under test
// (or transitively imported by it) that uses the "@/..." alias -- which is
// most of app/ and lib/ -- fails to resolve at import time in tests, no
// matter what's mocked (vi.mock() intercepts a specifier once it resolves,
// it doesn't make an unresolvable one resolve).
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    // web/e2e/**/*.spec.ts (Playwright, PR #124) matches Vitest's default
    // "*.spec.ts" include glob, and Vitest's worker throws immediately on
    // import since Playwright's test() must be called from Playwright's own
    // runner, not Vitest's -- "Playwright Test did not expect test() to be
    // called here." Extending (not replacing) configDefaults.exclude so
    // Vitest's own default ignores (node_modules, dist, etc.) stay intact.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
