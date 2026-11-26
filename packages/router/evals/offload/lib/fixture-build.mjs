// Shared helper for the offload eval's check scripts: compile the fixture's TypeScript with the
// router workspace's own `typescript` (no npm install inside the fixture, which would need
// network access) and run its `node --test` suite. Used by both arms (baseline and offload) and
// by `run.mjs --dry-run`'s self-test against the unmodified fixture and the reference solutions.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// evals/offload/lib -> packages/router
const ROUTER_DIR = path.resolve(HERE, "..", "..", "..");
const TSC_JS = path.join(ROUTER_DIR, "node_modules", "typescript", "lib", "tsc.js");
// The fixture is copied to a fresh temp directory for every run (dry-run self-test and each
// live arm alike), so tsconfig.json cannot name a relative `typeRoots` that only resolves next
// to the original fixture. `@types/node` (needed for `node:test`/`node:assert` types) is instead
// resolved here, as an absolute path fixed to this workspace, and passed on the command line.
const TYPE_ROOTS = path.join(ROUTER_DIR, "node_modules", "@types");

/** Runs `tsc -p tsconfig.json` in `fixtureDir` with the router workspace's typescript. */
export function buildFixture(fixtureDir) {
  if (!existsSync(TSC_JS)) return { ok: false, stage: "build", output: `typescript not found at ${TSC_JS}; run \`pnpm install\` in the router workspace first` };
  const r = spawnSync(process.execPath, [TSC_JS, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS], { cwd: fixtureDir, encoding: "utf8" });
  return { ok: r.status === 0, stage: "build", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Runs `node --test` over the built tests. Node (22.11) only auto-discovers test files when no
 * path is given on the command line; an explicit directory argument (e.g. `--test dist/tests`)
 * is instead treated as a module specifier to `require` and fails with MODULE_NOT_FOUND. So this
 * runs with no path argument and `cwd` set to `dist`, which Node then recurses on its own.
 */
export function testFixture(fixtureDir) {
  const distDir = path.join(fixtureDir, "dist");
  if (!existsSync(distDir)) return { ok: false, stage: "test", output: `${distDir} does not exist (the build did not produce it)` };
  const r = spawnSync(process.execPath, ["--test"], { cwd: distDir, encoding: "utf8" });
  return { ok: r.status === 0, stage: "test", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Build then test; stops at the first failing stage. */
export function buildAndTest(fixtureDir) {
  const build = buildFixture(fixtureDir);
  if (!build.ok) return build;
  return testFixture(fixtureDir);
}

/** Reads a text file under `fixtureDir`, or "" if it does not exist (never throws). */
export function readIfExists(fixtureDir, relPath) {
  try {
    return readFileSync(path.join(fixtureDir, relPath), "utf8");
  } catch {
    return "";
  }
}
