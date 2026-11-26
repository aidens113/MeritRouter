// Task 06 (write missing tests): add tests/stats.test.ts covering average(), including its
// empty-array error, without changing src/stats.ts's behaviour.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildAndTest } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 06-write-tests.mjs <fixtureDir>");
  process.exit(2);
}

const testPath = path.join(fixtureDir, "tests", "stats.test.ts");
if (!existsSync(testPath)) {
  console.log("FAIL: tests/stats.test.ts does not exist.");
  process.exit(1);
}
const source = readFileSync(testPath, "utf8");
const testCount = (source.match(/\btest\s*\(/g) ?? []).length;
if (testCount < 2) {
  console.log(`FAIL: tests/stats.test.ts has only ${testCount} test() call(s); at least 2 are needed (a normal case and the empty-array error).`);
  process.exit(1);
}
if (!/average/.test(source)) {
  console.log("FAIL: tests/stats.test.ts does not mention average().");
  process.exit(1);
}
if (!/throws|rejects|assert\.throws/.test(source)) {
  console.log("FAIL: tests/stats.test.ts does not test the empty-array throw.");
  process.exit(1);
}

const built = buildAndTest(fixtureDir);
if (!built.ok) {
  console.log(`FAIL: build/test failed (${built.stage}):\n${built.output}`);
  process.exit(1);
}
console.log("PASS: tests/stats.test.ts covers average() (including the empty-array case), and the suite passes.");
process.exit(0);
