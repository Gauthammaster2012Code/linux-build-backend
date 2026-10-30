import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // Both packages ship TypeScript or import.meta.glob that Vite must transform.
    server: { deps: { inline: ["convex-test", "@convex-dev/better-auth"] } },
    include: ["test/**/*.test.ts"],
  },
});
