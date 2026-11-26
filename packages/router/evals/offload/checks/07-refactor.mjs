// Task 07 (refactor): extract the duplicated min/max clamp logic in money.ts's clampRange and
// stats.ts's clampToUnitRange into one shared `clamp` helper, keeping behaviour (and the tests)
// unchanged.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildAndTest } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 07-refactor.mjs <fixtureDir>");
  process.exit(2);
}

function allSourceText(dir) {
  let text = "";
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "dist" || name === "node_modules") continue;
      const p = path.join(d, name);
      const stat = statSync(p);
      if (stat.isDirectory()) walk(p);
      else if (/\.ts$/.test(name)) text += `\n// ---- ${p} ----\n${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return text;
}

const all = allSourceText(fixtureDir);
const sharedClampCalls = (all.match(/\bclamp\s*\(/g) ?? []).length;
// Each duplicate had this exact two-line pattern in money.ts and stats.ts specifically; a
// shared helper (wherever it lives, e.g. a new clamp.ts) is expected to still contain it once —
// that's the point of extracting it — so only money.ts and stats.ts are checked for leftovers.
const moneySource = readFileSync(path.join(fixtureDir, "src", "money.ts"), "utf8");
const statsSource = readFileSync(path.join(fixtureDir, "src", "stats.ts"), "utf8");
const DUPLICATE_PATTERN = /if \(value < min\) return min;\s*\n\s*if \(value > max\) return max;/;
const duplicatePatternCount = [moneySource, statsSource].filter((s) => DUPLICATE_PATTERN.test(s)).length;
if (sharedClampCalls < 2) {
  console.log(`FAIL: expected at least 2 calls to a shared clamp(...) helper (one from each of clampRange and clampToUnitRange); found ${sharedClampCalls}.`);
  process.exit(1);
}
if (duplicatePatternCount > 0) {
  console.log("FAIL: the original inline min/max duplication is still present; extract it into the shared helper instead of calling it alongside the old code.");
  process.exit(1);
}

const built = buildAndTest(fixtureDir);
if (!built.ok) {
  console.log(`FAIL: build/test failed (${built.stage}):\n${built.output}`);
  process.exit(1);
}
console.log("PASS: clampRange and clampToUnitRange both use a shared clamp() helper, the duplication is gone, and behaviour (tests) is unchanged.");
process.exit(0);
