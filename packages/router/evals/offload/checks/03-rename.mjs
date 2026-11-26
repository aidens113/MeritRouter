// Task 03 (mechanical rename): rename `legacySlugify` to `slugify` everywhere (src and tests).
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildAndTest } from "../lib/fixture-build.mjs";

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error("usage: node 03-rename.mjs <fixtureDir>");
  process.exit(2);
}

function grepTree(dir, pattern) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "dist" || name === "node_modules") continue;
      const p = path.join(d, name);
      const stat = statSync(p);
      if (stat.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && pattern.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

const leftover = grepTree(fixtureDir, /legacySlugify/);
if (leftover.length) {
  console.log(`FAIL: "legacySlugify" still appears in: ${leftover.join(", ")}`);
  process.exit(1);
}
const srcHasNewName = existsSync(path.join(fixtureDir, "src", "strings.ts")) && /\bexport function slugify\b/.test(readFileSync(path.join(fixtureDir, "src", "strings.ts"), "utf8"));
if (!srcHasNewName) {
  console.log('FAIL: src/strings.ts does not export a function named "slugify".');
  process.exit(1);
}
const built = buildAndTest(fixtureDir);
if (!built.ok) {
  console.log(`FAIL: build/test failed after the rename (${built.stage}):\n${built.output}`);
  process.exit(1);
}
console.log("PASS: legacySlugify was renamed to slugify everywhere, and the build and tests pass.");
process.exit(0);
