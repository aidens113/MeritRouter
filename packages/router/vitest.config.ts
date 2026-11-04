import { defineConfig } from "vitest/config";

// The router's own tests. Eval fixtures under evals/ (hidden tests included) are run by the
// qualification grader inside a copied fixture repository, never by this suite.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Git- and process-heavy tests exceed the 5 s default on a loaded Windows machine.
    testTimeout: 30_000,
    // Cleanup drains durable Git-backed reports before removing its fixture. The
    // 24-task throughput fixture measures roughly48s of valid close work; Vitest's
    // implicit10s hook limit can otherwise start another test before cleanup ends.
    // This changes no task, provider, approval or individual test-body deadline.
    hookTimeout: 120_000,
  },
});
