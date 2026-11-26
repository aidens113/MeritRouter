// Task 08 (review a diff): review/sample.diff introduces an off-by-one (`i <= nums.length`)
// that reads past the array end. The reviewer writes findings to ANSWER.md.
import { readIfExists } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 08-review.mjs <fixtureDir>");
  process.exit(2);
}
const answer = readIfExists(fixtureDir, "ANSWER.md").toLowerCase();
const flags = ["off-by-one", "off by one", "<=", "undefined", "nan", "out of bounds", "out-of-bounds"];
const hit = flags.find((f) => answer.includes(f));
if (hit) {
  console.log(`PASS: ANSWER.md flags the off-by-one bug (matched "${hit}").`);
  process.exit(0);
}
console.log(`FAIL: ANSWER.md does not flag the off-by-one loop bound bug in review/sample.diff (looked for any of: ${flags.join(", ")}).`);
process.exit(1);
