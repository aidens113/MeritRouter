#!/usr/bin/env node
// Supervisor-offload eval runner (lane E, supervisor-offload.md Phase 2/3). Plain Node, no test
// framework: `node evals/offload/run.mjs --dry-run` validates the 8 task definitions and proves
// each one's check script fails on the unmodified (or task-`setup`-broken) fixture and passes
// once that task's reference solution (evals/offload/reference/<id>/) is applied. That is the
// whole self-test; it never spawns a model.
//
import { appendFileSync, mkdtempSync, rmSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { prepareInstallation, prepareProject, readWorkerEvidence, startOperatorPanel } from "./lib/isolated-router.mjs";
import { claudeArguments, fixtureDelta, parseClaudeRun, summarizeComparison } from "./lib/comparison.mjs";

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

  node evals/offload/run.mjs --preflight [--task <id>]
      Provisions temporary fixture projects and checks the actual MCP tool list. No model calls.

  node evals/offload/run.mjs --yes --providers <file.json> --model <id>
      --claude-budget-usd <per-session> --worker-requests <total>
      [--claude <executable>] [--task <id>] [--out <new-dir>] [--operator-port <port>]
      Compares isolated Claude Code sessions with and without MeritRouter. The providers file
      contains only the MeritRouter providers section, using free-tier keys via api_key_env.
      The runner limits MeritRouter requests across all offload arms and disables paid routing.
      Use --operator-port to review synthetic fixtures' pending check approvals in a temporary
      loopback panel. Each check uses the normal checked operator approval path.
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

async function runComparison(args) {
  const tasks = loadTasks().filter(({ raw }) => !args.task || raw.id === args.task);
  if (!tasks.length) throw new Error(`Unknown task: ${args.task}`);
  for (const { file, raw } of tasks) {
    const problems = validateTask(raw, file);
    if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
  }
  const preflight = args.preflight;
  const cost = Number(args["claude-budget-usd"]);
  const maxRequests = preflight ? 1 : Number(args["worker-requests"]);
  if (!preflight && (!args.providers || !args.model || !(cost > 0 && Number.isFinite(cost)) || !Number.isSafeInteger(maxRequests) || maxRequests < 1)) {
    throw new Error("Live comparison requires --providers, --model, --claude-budget-usd and --worker-requests");
  }
  if (!preflight) {
    console.log(`Up to ${2 * tasks.length} Claude sessions at USD ${cost} each and ${maxRequests} MeritRouter model requests. MeritRouter paid routing is disabled.`);
  }
  const outDir = preflight ? null
    : args.out ? path.resolve(args.out) : mkdtempSync(path.join(tmpdir(), "meritrouter-offload-eval-results-"));
  if (outDir && args.out) mkdirSync(outDir);
  const journal = outDir ? path.join(outDir, "progress.jsonl") : null;
  if (journal) {
    writeFileSync(journal, "", { flag: "wx" });
    console.log(`Recording completed arms in ${journal}`);
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "meritrouter-offload-install-"));
  const fixtures = [];
  let panel;
  try {
    const installation = await prepareInstallation(scratch, preflight ? undefined : args.providers, maxRequests);
    if (!preflight && args["operator-port"]) {
      panel = await startOperatorPanel(installation.config, Number(args["operator-port"]));
      console.log(`Isolated operator panel: ${panel.url}`);
    }
    const results = [];
    for (const [index, { raw }] of tasks.entries()) {
      const arms = preflight ? ["offload"] : index % 2 ? ["offload", "baseline"] : ["baseline", "offload"];
      for (const arm of arms) {
        const dir = freshFixtureCopy(raw);
        fixtures.push(dir);
        const { base, mcpConfig, slug } = await prepareProject(installation, dir, raw, arm);
        if (preflight) {
          console.log(`PASS  ${raw.id}: fixture project and 12 MCP tools ready`);
          continue;
        }
        console.log(`RUN   ${raw.id} [${arm}]`);
        if (panel && slug) console.log(`Review pending requests at ${panel.url}/p/${slug}/tasks`);
        const run = spawnSync(args.claude ?? "claude", claudeArguments({ mcpConfig, arm, raw, model: args.model, cost, operatorAvailable: Boolean(panel) }), {
          cwd: dir, env: installation.environment, encoding: "utf8", timeout: 20 * 60 * 1000,
          maxBuffer: 16 * 1024 * 1024, windowsHide: true,
        });
        const claude = parseClaudeRun(run, arm);
        if (!claude.valid) {
          appendFileSync(journal, JSON.stringify({ task: raw.id, arm, claude }) + "\n");
          throw new Error(`${raw.id} [${arm}]: ${claude.failure}`);
        }
        const check = runCheck(raw.id, dir);
        const worker = await readWorkerEvidence(installation.config, slug);
        const delta = fixtureDelta(dir, base, raw.allowedPaths, worker?.acceptedIds ?? []);
        const pass = check.ok && !delta.outOfScope.length;
        const row = { task: raw.id, kind: raw.kind, arm, pass, claude, worker, delta, checkOutput: check.output };
        results.push(row);
        appendFileSync(journal, JSON.stringify(row) + "\n");
        console.log(`${pass ? "PASS" : "FAIL"}  ${raw.id} [${arm}]`);
        if (claude.apiEquivalentUsd !== null && claude.apiEquivalentUsd > cost) {
          throw new Error(`${raw.id} [${arm}]: reported Claude cost exceeded the session budget. Stopping the comparison.`);
        }
      }
    }
    if (preflight) return 0;
    const summary = summarizeComparison(results, loadTasks().length);
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model: args.model, results, summary }, null, 2), { flag: "wx" });
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Results written to ${path.join(outDir, "results.json")}`);
    return summary.accepted ? 0 : 1;
  } finally {
    await panel?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  const { values: args } = parseArgs({ options: {
    "dry-run": { type: "boolean" }, preflight: { type: "boolean" }, yes: { type: "boolean" },
    providers: { type: "string" }, model: { type: "string" }, claude: { type: "string" },
    "claude-budget-usd": { type: "string" }, "worker-requests": { type: "string" },
    task: { type: "string" }, out: { type: "string" }, "operator-port": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const modes = [args["dry-run"], args.preflight, args.yes].filter(Boolean);
  if (args.help || modes.length !== 1) {
    usage();
    process.exitCode = args.help ? 0 : 1;
  } else {
    process.exitCode = args["dry-run"] ? dryRun() : await runComparison(args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
