#!/usr/bin/env node
// Supervisor-offload eval runner (lane E, supervisor-offload.md Phase 2/3). Plain Node, no test
// framework: `node evals/offload/run.mjs --dry-run` validates the 8 task definitions and proves
// each one's check script fails on the unmodified (or task-`setup`-broken) fixture and passes
// once that task's reference solution (evals/offload/reference/<id>/) is applied. That is the
// whole self-test; it never spawns a model.
//
// `--yes` (never run by this worker; Phase 3's lead runs it, announced, on free providers only)
// runs the real two-arm comparison: headless Claude Code (`claude -p`) against a fresh temp copy
// of the fixture, once with no MeritRouter MCP server (`baseline`) and once with one configured
// (`offload`, via `--mcp-config <path>`), recording pass/fail against the task's check script and
// Claude's own reported token usage. This script does not stand up a MeritRouter MCP server or
// project itself (that is `meritrouter connect`, lane D's integrations module, and Phase 3's
// integration step); `--mcp-config` names an existing config to pass straight to `claude -p`.
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, "tasks");
const FIXTURE_DIR = path.join(HERE, "fixture");
const REFERENCE_DIR = path.join(HERE, "reference");
const SETUP_DIR = path.join(HERE, "setup");

const KINDS = new Set(["scout", "summarize", "edit", "implement", "run", "review"]);

function usage() {
  console.log(`Usage:
  node evals/offload/run.mjs --dry-run
      Validates every task definition and self-tests its check script (fails on the broken
      fixture, passes once the reference solution is applied). Spends nothing; spawns no model.

  node evals/offload/run.mjs --yes [--mcp-config <path>] [--task <id>] [--out <dir>]
      Runs the real baseline-vs-offload comparison with headless Claude Code. Spends real Claude
      usage (both arms) and, for the offload arm, whatever free-provider quota MeritRouter uses.
      Prints the planned spend and refuses to run without --yes.
`);
}

// ---------------------------------------------------------------------------------------------
// Task loading and validation
// ---------------------------------------------------------------------------------------------

function loadTasks() {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => ({ file: f, raw: JSON.parse(readFileSync(path.join(TASKS_DIR, f), "utf8")) }));
}

/** Returns a list of problems (empty = valid). Mechanical, no external schema library needed. */
function validateTask(raw, file) {
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  need(typeof raw.id === "string" && raw.id.length > 0, "id must be a non-empty string");
  need(raw.id === undefined || file.startsWith(raw.id), `id "${raw.id}" should match its filename (${file})`);
  need(typeof raw.kind === "string" && KINDS.has(raw.kind), `kind must be one of ${[...KINDS].join(", ")}`);
  need(typeof raw.goal === "string" && raw.goal.trim().length >= 10, "goal must be a descriptive string (>= 10 chars)");
  need(typeof raw.prompt === "string" && raw.prompt.trim().length >= 20, "prompt must be a descriptive string (>= 20 chars)");
  need(typeof raw.writable === "boolean", "writable must be a boolean");
  need(Array.isArray(raw.allowedPaths) && raw.allowedPaths.every((p) => typeof p === "string"), "allowedPaths must be an array of strings");
  need(Array.isArray(raw.contextFiles) && raw.contextFiles.every((p) => typeof p === "string"), "contextFiles must be an array of strings");
  if (raw.setup !== undefined) need(typeof raw.setup === "string" && existsSync(path.join(SETUP_DIR, raw.setup)), `setup "${raw.setup}" has no matching directory under evals/offload/setup/`);
  const checkScript = path.join(HERE, "checks", `${raw.id}.mjs`);
  need(existsSync(checkScript), `no check script at checks/${raw.id}.mjs`);
  need(existsSync(path.join(REFERENCE_DIR, raw.id ?? "")), `no reference solution directory at reference/${raw.id}/ (needed for --dry-run's self-test)`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Fixture copying
// ---------------------------------------------------------------------------------------------

function freshFixtureCopy(task) {
  const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-offload-eval-"));
  cpSync(FIXTURE_DIR, dir, { recursive: true, filter: (src) => !/[\\/](dist|node_modules)([\\/]|$)/.test(src) });
  if (task.setup) cpSync(path.join(SETUP_DIR, task.setup), dir, { recursive: true });
  return dir;
}

function applyReference(dir, taskId) {
  cpSync(path.join(REFERENCE_DIR, taskId), dir, { recursive: true });
}

function runCheck(taskId, dir) {
  const r = spawnSync(process.execPath, [path.join(HERE, "checks", `${taskId}.mjs`), dir], { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// ---------------------------------------------------------------------------------------------
// --dry-run: validate task files and self-test each check script
// ---------------------------------------------------------------------------------------------

function dryRun() {
  const tasks = loadTasks();
  let allOk = true;
  const rows = [];
  for (const { file, raw } of tasks) {
    const problems = validateTask(raw, file);
    if (problems.length) {
      allOk = false;
      rows.push({ id: raw.id ?? file, ok: false, detail: `invalid task definition: ${problems.join("; ")}` });
      continue;
    }
    const dir = freshFixtureCopy(raw);
    try {
      const baseline = runCheck(raw.id, dir);
      applyReference(dir, raw.id);
      const withReference = runCheck(raw.id, dir);
      const ok = !baseline.ok && withReference.ok;
      allOk = allOk && ok;
      rows.push({
        id: raw.id,
        ok,
        detail: ok
          ? "check fails on the unmodified fixture, passes with the reference solution"
          : `baseline should FAIL and did ${baseline.ok ? "PASS (wrong)" : "fail (ok)"}; with reference should PASS and did ${withReference.ok ? "pass (ok)" : "FAIL (wrong)"}. baseline: ${baseline.output.slice(0, 300)} | reference: ${withReference.output.slice(0, 300)}`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}: ${r.detail}`);
  console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} tasks self-test cleanly.`);
  return allOk ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// --yes: the real two-arm comparison (never invoked by this worker)
// ---------------------------------------------------------------------------------------------

/** A rough per-task-per-arm call budget, only for the spend estimate printed before running. */
const ESTIMATED_CALLS_PER_ARM = 6;

function plannedSpend(tasks, taskFilter) {
  const selected = taskFilter ? tasks.filter((t) => t.raw.id === taskFilter) : tasks;
  const arms = 2; // baseline, offload
  return { tasks: selected.length, arms, estimatedClaudeCalls: selected.length * arms * ESTIMATED_CALLS_PER_ARM };
}

function runClaudeHeadless(dir, prompt, mcpConfig) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  const r = spawnSync("claude", args, { cwd: dir, encoding: "utf8", timeout: 20 * 60 * 1000 });
  let usage = null;
  try {
    const parsed = JSON.parse(r.stdout ?? "");
    usage = parsed.usage ?? parsed.result?.usage ?? null;
  } catch {
    // Claude's JSON output format changed, or the run errored before producing JSON; the raw
    // stdout/stderr below is still recorded for the report.
  }
  return { status: r.status, usage, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function liveRun(args) {
  const tasks = loadTasks();
  const taskFilter = args.task ?? null;
  const spend = plannedSpend(tasks, taskFilter);
  console.log(`Planned spend: ${spend.tasks} task(s) x ${spend.arms} arms ~= ${spend.estimatedClaudeCalls} Claude Code turns (plus whatever free-provider quota the offload arm's MeritRouter workers use). Each task also runs its deterministic check script, which spends nothing.`);
  if (!args.yes) {
    console.log("Refusing to run without --yes.");
    return 1;
  }
  const outDir = args.out ?? mkdtempSync(path.join(tmpdir(), "meritrouter-offload-eval-results-"));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const { raw } of tasks) {
    if (taskFilter && raw.id !== taskFilter) continue;
    for (const arm of ["baseline", "offload"]) {
      const dir = freshFixtureCopy(raw);
      try {
        const run = runClaudeHeadless(dir, raw.prompt, arm === "offload" ? args.mcpConfig : undefined);
        const check = runCheck(raw.id, dir);
        results.push({ task: raw.id, arm, pass: check.ok, claudeStatus: run.status, usage: run.usage, checkOutput: check.output });
        console.log(`${check.ok ? "PASS" : "FAIL"}  ${raw.id} [${arm}]`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${path.join(outDir, "results.json")}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dryRun: false, yes: false, task: null, mcpConfig: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--task") out.task = argv[++i];
    else if (a === "--mcp-config") out.mcpConfig = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.dryRun && !args.yes)) {
  usage();
  process.exit(args.help ? 0 : 1);
}
const code = args.dryRun ? dryRun() : await liveRun(args);
process.exit(code);
