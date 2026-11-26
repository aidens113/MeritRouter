// Task 02 (summarize log/test output): summarize logs/failing-run.txt's root cause in ANSWER.md.
import { readIfExists } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 02-summarize.mjs <fixtureDir>");
  process.exit(2);
}
const answer = readIfExists(fixtureDir, "ANSWER.md").toLowerCase();
const mentionsTest = answer.includes("formats negative cents") || answer.includes("money");
const mentionsCause = answer.includes("sign") || answer.includes("$-1.50") || answer.includes("dollar sign");
if (mentionsTest && mentionsCause) {
  console.log("PASS: ANSWER.md identifies the failing money test and the sign-placement cause.");
  process.exit(0);
}
console.log(`FAIL: ANSWER.md does not clearly summarize the log (test named: ${mentionsTest}, cause named: ${mentionsCause}).`);
process.exit(1);
