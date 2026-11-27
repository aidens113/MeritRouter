// Host-side staging only. Generated JavaScript is executed exclusively by Docker.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, "../../..");
const REPOSITORY = path.resolve(ROUTER, "../..");
const require = createRequire(import.meta.url);
const TASKS = new Set(["03-rename", "04-feature", "05-bugfix", "06-write-tests", "07-refactor"]);
const TIMEOUT_MS = 120_000;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Do not follow junctions, symlinks, or special files in model-controlled input.
function copyTree(source, destination, budget) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Links are not permitted: ${source}`);
  if (++budget.files > budget.maxFiles) throw new Error("Staging file limit exceeded");
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), budget);
  } else if (stat.isFile()) {
    budget.bytes += stat.size;
    if (budget.bytes > budget.maxBytes) throw new Error("Staging byte limit exceeded");
    copyFileSync(source, destination);
  } else throw new Error(`Only regular files and directories are permitted: ${source}`);
}

function dockerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && /^(PATH|SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)));
}

/** Independently grade an already materialized synthetic coding fixture. No pulls or startup. */
export function gradeCodingFixture(taskId, fixtureDir, { image } = {}) {
  let staging;
  let name;
  let attempted = false;
  let result = { ok: false, output: "Grader did not run" };
  const env = dockerEnvironment();
  try {
    if (!TASKS.has(taskId)) throw new Error("Unsupported coding fixture task ID");
    if (typeof image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) {
      throw new Error("An explicit already downloaded Node 22 image reference is required");
    }
    if (typeof fixtureDir !== "string" || !path.isAbsolute(fixtureDir)) throw new Error("Fixture path must be absolute");
    const fixture = realpathSync(fixtureDir);
    if (!within(realpathSync(tmpdir()), fixture) || fixture === REPOSITORY || within(REPOSITORY, fixture)) {
      throw new Error("Fixture must reside in OS temporary storage outside the repository");
    }
    if (lstatSync(fixtureDir).isSymbolicLink()) throw new Error("Fixture directory must not be a link");
    if (!lstatSync(fixture).isDirectory()) throw new Error("Fixture must be a directory");
    staging = mkdtempSync(path.join(tmpdir(), "meritrouter-container-grade-"));
    const input = path.join(staging, "input");
    const trusted = path.join(staging, "trusted");
    mkdirSync(input);
    mkdirSync(path.join(trusted, "evals/offload/checks"), { recursive: true });
    mkdirSync(path.join(trusted, "evals/offload/lib"), { recursive: true });
    const inputBudget = { files: 0, bytes: 0, maxFiles: 256, maxBytes: 4 * 1024 * 1024 };
    for (const entry of ["src", "tests", "package.json", "tsconfig.json"]) {
      copyTree(path.join(fixture, entry), path.join(input, entry), inputBudget);
    }
    // Resolve package roots first: pnpm's installed dependency links are never mounted.
    const assetBudget = { files: 0, bytes: 0, maxFiles: 3000, maxBytes: 128 * 1024 * 1024 };
    for (const dependency of ["typescript", "@types/node", "undici-types"]) {
      const resolver = dependency === "undici-types" ? createRequire(require.resolve("@types/node/package.json")) : require;
      const source = path.dirname(realpathSync(resolver.resolve(`${dependency}/package.json`)));
      const destination = path.join(trusted, "node_modules", dependency);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyTree(source, destination, assetBudget);
    }
    copyFileSync(path.join(HERE, "fixture-build.mjs"), path.join(trusted, "evals/offload/lib/fixture-build.mjs"));
    copyFileSync(path.join(HERE, "../checks", `${taskId}.mjs`), path.join(trusted, "evals/offload/checks", `${taskId}.mjs`));
    writeFileSync(path.join(trusted, "entry.mjs"), `
import { cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.versions.node.split('.')[0] !== '22') throw new Error('Grader requires Node 22');
cpSync('/input', '/work/fixture', { recursive: true });
const r = spawnSync(process.execPath, ['/trusted/evals/offload/checks/${taskId}.mjs', '/work/fixture'], {
  cwd: '/work', encoding: 'utf8', timeout: 100000, maxBuffer: 1048576,
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp' }
});
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
if (r.error) process.stderr.write(String(r.error));
process.exit(r.status === 0 && !r.error ? 0 : 1);
`);
    name = `meritrouter-grade-${randomUUID()}`;
    // --mount uses comma-separated fields; refuse paths that Docker could parse differently.
    if (staging.includes(",") || /[\r\n]/.test(staging)) throw new Error("Unsupported temporary storage path");
    const args = ["run", "--pull=never", "--rm", "--name", name,
      "--network=none", "--read-only", "--user", "65534:65534", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--cpus=1", "--memory=512m", "--memory-swap=512m",
      "--pids-limit=64", "--ulimit", "nofile=256:256", "--init",
      "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777",
      "--mount", `type=bind,source=${input},target=/input,readonly`,
      "--mount", `type=bind,source=${trusted},target=/trusted,readonly`,
      "--workdir", "/work", "--env", "HOME=/work", "--env", "TMPDIR=/tmp",
      "--entrypoint", "node", image, "/trusted/entry.mjs"];
    attempted = true;
    const run = spawnSync("docker", args, { env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    result = { ok: run.status === 0 && !run.error, output: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\nDocker execution failed: ${run.error.message}` : ""}` };
    if (!result.ok && !result.output) result.output = `Docker grader exited with status ${run.status}, signal ${run.signal}`;
  } catch (error) {
    result = { ok: false, output: `Container grading refused: ${error.message}` };
  } finally {
    if (attempted) {
      const cleanup = spawnSync("docker", ["rm", "--force", name], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
      // --rm normally already removed it. Any other failure means cleanup is unverified.
      if (cleanup.error || (cleanup.status !== 0 && !/No such container/i.test(cleanup.stderr ?? ""))) {
        result.ok = false;
        result.output += `\nContainer cleanup unverified (${name}): ${cleanup.error?.message ?? cleanup.stderr ?? cleanup.status}`;
      }
    }
    if (staging) {
      try { rmSync(staging, { recursive: true, force: true }); }
      catch (error) { result.ok = false; result.output += `\nStaging cleanup failed: ${error.message}`; }
    }
  }
  return result;
}
