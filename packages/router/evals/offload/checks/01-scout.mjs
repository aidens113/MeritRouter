// Task 01 (scout): find the sign-placement bug in money.ts and report it in ANSWER.md. No code
// changes needed; the check is purely over the written answer.
import { readIfExists } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 01-scout.mjs <fixtureDir>");
  process.exit(2);
}
const answer = readIfExists(fixtureDir, "ANSWER.md").toLowerCase();
const mentionsFile = answer.includes("money.ts");
const mentionsBadOutput = answer.includes("$-1.50") || (answer.includes("$-1") && answer.includes("1.50"));
const mentionsGoodOutput = answer.includes("-$1.50");
if (mentionsFile && mentionsBadOutput && mentionsGoodOutput) {
  console.log("PASS: ANSWER.md names money.ts and both the buggy and the correct output for -150 cents.");
  process.exit(0);
}
console.log(`FAIL: ANSWER.md is missing one of: a reference to money.ts (${mentionsFile}), the buggy output $-1.50 (${mentionsBadOutput}), or the correct output -$1.50 (${mentionsGoodOutput}).`);
process.exit(1);
