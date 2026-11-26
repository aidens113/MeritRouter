// Task 04 (small feature with tests): implement isPalindrome in src/palindrome.ts, with its own
// test file, so pnpm... (here: npm) test passes and the new behaviour is actually exercised.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildAndTest } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 04-feature.mjs <fixtureDir>");
  process.exit(2);
}

const hasTestFile = existsSync(path.join(fixtureDir, "tests", "palindrome.test.ts"));
if (!hasTestFile) {
  console.log("FAIL: tests/palindrome.test.ts does not exist; the worker must add its own test, not just the implementation.");
  process.exit(1);
}

const built = buildAndTest(fixtureDir);
if (!built.ok) {
  console.log(`FAIL: build/test failed (${built.stage}):\n${built.output}`);
  process.exit(1);
}

const compiled = path.join(fixtureDir, "dist", "src", "palindrome.js");
if (!existsSync(compiled)) {
  console.log("FAIL: dist/src/palindrome.js was not produced by the build.");
  process.exit(1);
}
const mod = await import(pathToFileURL(compiled).href);
if (typeof mod.isPalindrome !== "function") {
  console.log("FAIL: palindrome.ts does not export a function named isPalindrome.");
  process.exit(1);
}
const cases = [
  ["A man a plan a canal Panama", true],
  ["hello", false],
  ["", true],
];
for (const [input, expected] of cases) {
  const actual = mod.isPalindrome(input);
  if (actual !== expected) {
    console.log(`FAIL: isPalindrome(${JSON.stringify(input)}) returned ${actual}, expected ${expected}.`);
    process.exit(1);
  }
}
console.log("PASS: isPalindrome is implemented correctly, has its own test file, and the suite passes.");
process.exit(0);
