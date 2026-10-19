import { defineConfig } from "vitest/config";

// The router's own tests. Eval fixtures under evals/ (hidden tests included) are run by the
// qualification grader inside a copied fixture repository, never by this suite.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Git- and process-heavy tests exceed the 5 s default on a loaded Windows machine.
    testTimeout: 30_000,
  },
});
