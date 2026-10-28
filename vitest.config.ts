import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Most integration files launch their own Chromium and mock portals. Uncapped, a 20-core machine starts
    // ~16 of them in the first seconds, and a launch that waits out the 60 s hook timeout fails every test in
    // its file at once. Eight at a time keeps the suite fast without that pile-up.
    maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1)),
  },
});
