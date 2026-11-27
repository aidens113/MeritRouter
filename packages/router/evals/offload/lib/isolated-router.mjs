import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { git } from "./comparison.mjs";

const router = fileURLToPath(new URL("../../../", import.meta.url));
const dist = path.join(router, "dist");
const cli = path.join(dist, "cli.js");
function execCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.MERITROUTER_MASTER_KEY;
  return execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 120_000, windowsHide: true });
}

export async function prepareInstallation(root, providerFile, maxRequests, local) {
  if (!existsSync(cli)) throw new Error("Build the router first with pnpm --filter meritrouter build");
  const { parseConfig } = await import("../../../dist/index.js");
  const providers = local ? { ollama: { base_url: `${local.url}/v1`, default_context_tokens: 8192 } }
    : providerFile ? JSON.parse(readFileSync(providerFile, "utf8")) : {};
  const config = path.join(root, "meritrouter.config.yaml");
  const settings = YAML.parse(readFileSync(path.join(router, "examples", "presets", "standalone-free.yaml"), "utf8"));
  delete settings.repositories;
  delete settings.projects;
  settings.storage = { directory: ".MeritRouter", layout: "split", durability: "full" };
  settings.brain = { path: ".MeritRouter/brain", project: "benchmark", worker_reports: false };
  settings.panel = { auto_start: false };
  settings.providers = providers;
  settings.discovery = { interval_minutes: 0, probe_tools: false };
  settings.client_supervision = { tools: "core" };
  settings.allocation = { max_model_requests_per_hour: maxRequests, max_model_requests_per_day: maxRequests };
  settings.models = { file: "models.yaml" };
  if (local) {
    // Only this temporary installation uses the smaller local-model fixture preset.
    for (const tier of Object.values(settings.tiers)) tier.min_total_parameters_b = 1;
    for (const profile of Object.values(settings.profiles)) {
      profile.min_total_parameters_b = 1;
      // Fixture inputs are fixed and already scoped by the deterministic driver.
      profile.classify = "never";
    }
  }
  const resolved = parseConfig(settings, config);
  const providerKeyVariables = new Set();
  const keys = [];
  if (providerFile) {
    const entries = Object.entries(resolved.providers.byId);
    if (!entries.some(([, entry]) => entry.enabled)) throw new Error("The providers file needs at least one enabled free provider");
    for (const [id, entry] of entries) {
      if (Object.keys(entry.headers).length) throw new Error("Custom provider headers are unavailable in the benchmark");
      for (const key of entry.keys) {
        if (key.billing_class !== "free_tier" || !key.api_key_env || !process.env[key.api_key_env]) {
          throw new Error("Use free_tier credentials from populated api_key_env variables");
        }
        providerKeyVariables.add(key.api_key_env.toUpperCase());
        if (entry.enabled && key.enabled) keys.push({ id, key });
      }
      // Load secrets into the isolated vault. Claude does not need the worker credentials.
      settings.providers[id].keys = [];
    }
  }
  copyFileSync(path.join(router, "examples", "models.example.yaml"), path.join(root, "models.yaml"));
  writeFileSync(config, YAML.stringify(settings), { flag: "wx" });
  for (const { id, key } of keys) {
    const flags = [["label", key.label], ["account-id", key.account_id], ["quota-group", key.quota_group],
      ["rpm", key.rpm], ["rpd", key.rpd], ["tpm", key.tpm], ["tpd", key.tpd]];
    execCli(["keys", "add", id, "--billing", "free_tier", "--no-scan", "--config", config,
      ...flags.flatMap(([name, value]) => value ? [`--${name}`, String(value)] : []),
    ], root, { MERITROUTER_NEW_KEY: process.env[key.api_key_env] });
  }
  // Discovery spends no model requests with probe_tools disabled.
  if (providerFile || local) {
    const scan = JSON.parse(execCli(["models", "scan", "--config", config, "--json"], root));
    if (local && !scan.providers?.includes("ollama")) throw new Error("MeritRouter could not discover the local Ollama provider");
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !providerKeyVariables.has(name.toUpperCase())));
  delete environment.MERITROUTER_MASTER_KEY;
  delete environment.MERITROUTER_OFFLOAD_OPERATOR_TOKEN;
  delete environment.MERITROUTER_PANEL_TOKEN;
  delete environment.MERITROUTER_NEW_KEY;
  return { root, config, preflight: !providerFile && !local, environment };
}

export async function readFixtureResult(config, slug, taskId) {
  const { MeritRouter, loadConfig } = await import("../../../dist/index.js");
  const router = new MeritRouter(loadConfig(config), { worker: false, panelLifecycle: "passive" });
  try {
    return router.collectResults([taskId], slug).completed[0] ?? null;
  } finally {
    await router.close();
  }
}

export async function prepareProject(installation, dir, task, arm) {
  writeFileSync(path.join(dir, ".gitignore"), "dist/\nnode_modules/\n.MeritRouter/\n");
  writeFileSync(path.join(dir, "eval-test.mjs"),
    `import { buildAndTest } from ${JSON.stringify(new URL("./fixture-build.mjs", import.meta.url).href)};\n` +
    "const result = buildAndTest(process.cwd());\nconsole.log(result.output);\nprocess.exitCode = result.ok ? 0 : 1;\n");
  const manifestPath = path.join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.scripts.test = "node eval-test.mjs";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  git(dir, "init", "--quiet");
  git(dir, "config", "--local", "core.autocrlf", "false");
  git(dir, "config", "--local", "user.name", "MeritRouter benchmark");
  git(dir, "config", "--local", "user.email", "benchmark@example.invalid");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "-m", "Fixture base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  const mcpConfig = path.join(installation.root, `${task.id}-${arm}.json`);
  const slug = arm === "offload" ? `eval-${task.id}` : null;
  const servers = {};
  if (slug) {
    const created = JSON.parse(execCli(
      ["projects", "create", slug, dir, "--repo", `app=${dir}`, "--config", installation.config, "--json"], installation.root,
    ));
    if (!created.project?.repositories?.some((repo) => repo.alias === "app" && repo.exists)) {
      throw new Error("The benchmark project is missing its app repository");
    }
    const server = { command: process.execPath, args: [cli, "mcp", "--config", installation.config, "--project", slug] };
    // The preflight connection is passive and cannot process queued work.
    if (!installation.preflight) server.args.push("--worker");
    const client = new Client({ name: "offload-benchmark-preflight", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ ...server, args: server.args.filter((arg) => arg !== "--worker"), cwd: dir, stderr: "pipe" }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      if (names.length !== 12 || !names.includes("delegate") || !names.includes("offload_report")) {
        throw new Error(`Expected 12 core MeritRouter tools, got ${names.join(", ")}`);
      }
    } finally {
      await client.close();
    }
    servers.meritrouter = server;
  }
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }), { flag: "wx" });
  return { base, mcpConfig, slug };
}

export async function readWorkerEvidence(config, slug) {
  if (!slug) return null;
  const [{ MeritRouter, loadConfig }, { requireProjectStores }, { WorkerResultSchema }] = await Promise.all([
    import("../../../dist/index.js"), import("../../../dist/admin/project-reads.js"), import("../../../dist/core/task.js"),
  ]);
  const router = new MeritRouter(loadConfig(config), { worker: false });
  try {
    const { db } = requireProjectStores(router, slug);
    const results = db.prepare("SELECT result_json FROM tasks WHERE project_id = ? AND result_json IS NOT NULL").all(slug)
      .map(({ result_json }) => WorkerResultSchema.parse(JSON.parse(result_json)));
    const accepted = results.filter((result) => result.executionStatus === "completed" && result.acceptanceStatus === "met" && result.servedEndpoints.length);
    return {
      acceptedIds: accepted.map((result) => result.taskId),
      acceptedChecks: accepted.reduce((total, result) => total + result.checks.filter((check) => check.exitCode === 0).length, 0),
      requests: db.prepare("SELECT count(*) AS count FROM model_requests").get().count,
    };
  } finally {
    await router.close();
  }
}

export async function startOperatorPanel(config, port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error("Choose an unoccupied --operator-port between 1024 and 65535");
  const token = process.env.MERITROUTER_OFFLOAD_OPERATOR_TOKEN;
  if (!token) throw new Error("Set MERITROUTER_OFFLOAD_OPERATOR_TOKEN for the operator login");
  const [{ findPanelApp, panelListening }, { killTree }] = await Promise.all([
    import("../../../dist/operations/panel.js"), import("../../../dist/runners/coding/process.js"),
  ]);
  if (await panelListening(port)) throw new Error(`The operator port ${port} is already in use`);
  const app = findPanelApp(router);
  if ("problem" in app) throw new Error(app.problem);
  const env = { ...process.env, MERITROUTER_CONFIG: config, MERITROUTER_PANEL_TOKEN: token, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.MERITROUTER_MASTER_KEY;
  const server = spawn(process.execPath, [app.nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: app.dir, env, windowsHide: true, detached: process.platform !== "win32", stdio: "ignore",
  });
  let spawnError;
  server.on("error", (error) => { spawnError = error; });
  const stopped = new Promise((resolve) => server.once("close", resolve));
  const close = async () => { await killTree(server); await stopped; };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error("Unable to start the isolated operator panel");
      if (await panelListening(port, 200)) return { url: `http://127.0.0.1:${port}`, close };
      await delay(200);
    }
    throw new Error("The isolated operator panel did not become ready");
  } catch (error) {
    await close();
    throw error;
  }
}
