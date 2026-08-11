import { defineConfig } from "vitest/config";

// NLP regression harness (specs/hebrew-nlp/spec.md §3.5): tests hit local
// dockerized OpenSearch, seeded once from the frozen Phase 0 corpus by
// globalSetup. Tests are read-only against the seeded index, so files may run
// in parallel.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/nlp/global-setup.ts"],
    testTimeout: 30_000,
  },
});
