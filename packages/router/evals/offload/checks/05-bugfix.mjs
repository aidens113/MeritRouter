// Task 05 (bug fix with failing test): fix formatCurrencyCents so the existing (already written)
// negative-cents test in tests/money.test.ts passes, without weakening the test itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAndTest } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 05-bugfix.mjs <fixtureDir>");
  process.exit(2);
}

const testSource = readFileSync(path.join(fixtureDir, "tests", "money.test.ts"), "utf8");
if (!testSource.includes('"-$1.50"') && !testSource.includes("'-$1.50'")) {
  console.log("FAIL: the negative-cents test no longer asserts -$1.50; the test must not be weakened to make the bug pass.");
  process.exit(1);
}

const built = buildAndTest(fixtureDir);
if (!built.ok) {
  console.log(`FAIL: build/test failed (${built.stage}):\n${built.output}`);
  process.exit(1);
}
console.log("PASS: the build and full test suite pass, with the original negative-cents assertion intact.");
process.exit(0);
