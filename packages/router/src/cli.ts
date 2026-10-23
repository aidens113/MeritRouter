#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, resolveConfigPath, DEFAULT_CONFIG_NAME } from "./config/load.js";
import { PROFILE_NAMES, TIER_NAMES, type ProfileName, type TierName } from "./config/schema.js";
import { MeritRouter } from "./core/service.js";
import { createCodingRunner } from "./runners/coding/index.js";
import { z } from "zod";
import { brainAccessRequests, brainRead, brainSearch, brainTree, budgetRequestsView, CHANNEL_KINDS, decideBrainAccess, decideBudgetRequest, decideTaskAcceptance, jobChannel, jobDetail, jobMetrics, jobPlan, jobsView, jobTeam, modelsView, routingPreview, selectableProjects, sessionDetail, sessionsView } from "./admin/insights.js";
import { comparison, comparisons, planComparison, runComparison } from "./qualification/comparison.js";
import { blame } from "./attribution/index.js";
import { MeritRouterError } from "./core/errors.js";
import { BUDGET_REQUEST_STATUSES, type BudgetRequestStatus } from "./admission/budget-requests.js";
import { countFlag, repoFlags, statusFlag, withImportance } from "./cli/args.js";
import { doctorChecks, doctorText } from "./cli/doctor.js";
import { keysCommand } from "./cli/keys.js";
import { HELP } from "./cli/help.js";
import { channelText, jobTeamLines } from "./cli/job-team-text.js";
import { comparisonPlanText, comparisonsTable, comparisonText, metricsText } from "./cli/metrics-text.js";
import { operationsCommand } from "./cli/operations.js";
import { planText } from "./cli/plan-text.js";
import { chooseProject, PROJECT_ENV, requireProject, type SelectOptions } from "./cli/project-select.js";
import { projectsCommand } from "./cli/projects.js";
import { initializeConfig } from "./cli/setup.js";
import { serveLabs, stopLabSupervisor } from "./cli/lab-supervisor.js";
import { ensureLabSupervisor, LabSupervisorLease } from "./operations/lab-supervisor.js";
import { labsCommand } from "./cli/labs.js";
import { sessionRows, sessionTimeline } from "./cli/session-text.js";
import { out, table } from "./cli/terminal.js";
import { ensurePanel, revivePanel } from "./operations/panel.js";
import { mcpOptions, runMcpServer } from "./mcp/serve.js";
import type { ScanSummary } from "./models/scanner.js";

// The `meritrouter` command: argument parsing and dispatch. Terminal rendering lives in src/cli/.

/** Who accepts from this terminal: `cli:<os user>`. */
function cliActor(): string {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? "";
  }
  return `cli:${user || "unknown"}`;
}

const CLI_PATH = fileURLToPath(import.meta.url);

/** `models scan` as terminal text. */
function scanText(s: ScanSummary): string {
  return [
    s.providers.length ? `listed ${s.providers.length} provider(s): ${s.providers.join(", ")}; ${s.scanned} model(s), ${s.added.length} new, ${s.unavailable.length} now unavailable` : "no provider was listed",
    ...(s.pendingConfirmation.length ? [`${s.pendingConfirmation.length} model(s) wait for parameter confirmation: meritrouter models confirm <id>`] : []),
    ...s.errors.map((e) => `error: ${e}`),
  ].join("\n");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      timeout: { type: "string" },
      hours: { type: "string" },
      params: { type: "string" },
      active: { type: "string" },
      trials: { type: "string" },
      repo: { type: "string", multiple: true },
      check: { type: "string", multiple: true },
      criteria: { type: "string", multiple: true },
      preset: { type: "string" },
      ref: { type: "string" },
      label: { type: "string" },
      billing: { type: "string" },
      balance: { type: "string" },
      cap: { type: "string" },
      rpm: { type: "string" },
      rpd: { type: "string" },
      tpm: { type: "string" },
      tpd: { type: "string" },
      "quota-group": { type: "string" },
      "account-id": { type: "string" },
      test: { type: "boolean", default: false },
      "no-scan": { type: "boolean", default: false },
      // projects delete <slug> --confirm <slug>
      confirm: { type: "string" },
      status: { type: "string" },
      task: { type: "string" },
      job: { type: "string" },
      lab: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      reason: { type: "string" },
      grant: { type: "string" },
      importance: { type: "string" },
      "importance-reason": { type: "string" },
      force: { type: "boolean", default: false },
      "include-master-key": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "max-restarts": { type: "string" },
      window: { type: "string" },
      "max-delay": { type: "string" },
      name: { type: "string" },
      kind: { type: "string" },
      eval: { type: "string" },
      goals: { type: "string" },
      "team-factor": { type: "string" },
      "team-requests": { type: "string" },
      yes: { type: "boolean", default: false },
      // meritrouter mcp (mcp/serve.ts)
      "no-worker": { type: "boolean", default: false },
      "no-panel": { type: "boolean", default: false },
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = values.json ?? false;

  if (cmd === "init" || cmd === "setup") {
    if (args[0] && values.config) throw new MeritRouterError("usage", "choose a directory or --config, not both");
    const configPath = values.config ? resolveConfigPath(values.config) : cmd === "init"
      ? path.join(path.resolve(args[0] ?? "."), DEFAULT_CONFIG_NAME)
      : args[0] ? path.join(path.resolve(args[0]), DEFAULT_CONFIG_NAME) : resolveConfigPath(values.config);
    const requestedRepos = repoFlags(values.repo);
    const repositories = cmd === "setup" ? Object.fromEntries(Object.entries(requestedRepos).map(([alias, repo]) => [alias, { path: path.resolve(repo.path) }])) : requestedRepos;
    const messages = initializeConfig({
      configPath, preset: values.preset, project: values.project ?? process.env[PROJECT_ENV] ?? "my-project",
      ...(values.name ? { name: values.name } : {}), repositories, setup: cmd === "setup",
      ...(values.port !== undefined ? { port: Number(values.port) } : {}),
    });
    for (const message of messages) out(message, false);
    if (cmd === "setup" && !values["no-panel"]) {
      const status = await ensurePanel(loadConfig(configPath), { force: true });
      out(status.detail, false);
      return status.state === "running" || status.state === "started" ? 0 : 1;
    }
    return 0;
  }

  // The MCP server opens its own MeritRouter (with or without a worker) and serves until its
  // client disconnects (stdio) or it is interrupted (HTTP).
  if (cmd === "mcp") {
    await runMcpServer(mcpOptions(values));
    return 0;
  }

  const cfg = loadConfig(values.config);
  // Operations work on the storage directory directly and must not open a MeritRouter (restore
  // replaces the database; the daemon's worker runs in a child process).
  if (cmd === "backup" || cmd === "restore" || cmd === "daemon" || cmd === "service") return operationsCommand(cmd, args, values, cfg, json, CLI_PATH);
  const compareRun = cmd === "compare" && args[0] !== "list" && args[0] !== "show" && values.yes && !values["dry-run"];
  const worker = cmd === "worker" || (cmd === "submit" && values.wait) || compareRun;
  const sy = new MeritRouter(cfg, { worker, coding: createCodingRunner(cfg) });
  // The project a command works in: --project, then MERITROUTER_PROJECT, then the only project,
  // then the project whose repository contains the working directory (see cli/project-select.ts).
  const explicit = values.project ?? process.env[PROJECT_ENV];
  const select: SelectOptions = { flag: values.project, env: process.env[PROJECT_ENV], cwd: process.cwd() };
  /** Writes and repository reads: a project is required (an error lists the projects). */
  const project = () => requireProject(selectableProjects(sy), select).slug;
  /** Lists: the chosen project, or every project when none can be chosen. */
  const listScope = () => chooseProject(selectableProjects(sy), select)?.slug;
  /** Commands on ids: guarded by a project only when one was named. */
  const idScope = () => (explicit ? project() : undefined);
  const multi = sy.projects.slugs().length > 1;
  try {
    if (explicit && cmd !== "projects") project();
    switch (cmd) {
      case "projects":
        return await projectsCommand(sy, args, values, json, select);
      case "labs": {
        const action = args[0] ?? "list";
        if (explicit && ["serve", "supervisor-start", "supervisor-stop", "supervisor-status"].includes(action)) throw new MeritRouterError("usage", "Labs supervision serves every project in this installation; remove --project and MERITROUTER_PROJECT");
        if (action === "serve") { await serveLabs(sy); return 0; }
        if (action === "supervisor-start") { await ensureLabSupervisor(sy, CLI_PATH); out({ running: true }, json); return 0; }
        if (action === "supervisor-stop") { out({ stopped: await stopLabSupervisor(sy) }, json); return 0; }
        if (action === "supervisor-status") { out(new LabSupervisorLease(sy.db, cfg.configPath).read(), true); return 0; }
        return labsCommand(sy, args, values, json, { project, list: listScope }, CLI_PATH);
      }
      case "panel": {
        // Start the panel now, even when panel.auto_start is off or it was turned off (the user asked for it).
        const p = await ensurePanel(cfg, { force: true });
        out(json ? p : p.detail, json);
        return p.state === "running" || p.state === "started" ? 0 : 1;
      }
      case "doctor": {
        // Reads stored state only: per-provider keys, health, and last listing; never calls a provider.
        // Repositories are prepared first (created, set up with git), so only what MeritRouter cannot fix fails.
        const projects = explicit ? [project()] : undefined;
        const prepared = await sy.prepareRepositories(projects ? { projects } : {});
        const checks = doctorChecks(sy, { ...(projects ? { projects } : {}), prepared });
        out(json ? checks : doctorText(checks), json);
        return checks.every((c) => c.ok) ? 0 : 1;
      }
      case "models": {
        const sub = args[0];
        if (sub === "scan") {
          const summary = await sy.scan();
          out(json ? summary : scanText(summary), json);
          // Exit 1 only when nothing could be listed and something went wrong.
          return summary.providers.length === 0 && summary.errors.length > 0 ? 1 : 0;
        }
        if (sub === "show") {
          const m = modelsView(sy).find((x) => x.endpoint.id === args[1]);
          if (!m) throw new MeritRouterError("not_found", `unknown model ${args[1]}`);
          out(m, true);
          return 0;
        }
        if (sub === "confirm") {
          const id = args[1]!;
          const prev = sy.catalog.override(id) ?? {};
          sy.catalog.setOverride(id, {
            ...prev,
            confirmParams: true,
            ...(values.params ? { totalParametersB: Number(values.params) } : {}),
            ...(values.active ? { activeParametersB: Number(values.active) } : {}),
          });
          out(`${id}: ${sy.catalog.get(id)?.status}`, json);
          return 0;
        }
        if (sub === "enable" || sub === "disable") {
          const id = args[1]!;
          sy.catalog.setOverride(id, { ...(sy.catalog.override(id) ?? {}), forceStatus: sub === "enable" ? "active" : "disabled" });
          out(`${id}: ${sy.catalog.get(id)?.status}`, json);
          return 0;
        }
        const rows = modelsView(sy)
          .filter((m) => values.all || m.endpoint.status !== "removed")
          .map((m) => ({
            model: m.endpoint.id,
            status: m.endpoint.status,
            params: m.endpoint.totalParametersB === null ? "?" : `${m.endpoint.totalParametersB}B${m.endpoint.activeParametersB ? `/${m.endpoint.activeParametersB}B` : ""}`,
            confidence: m.endpoint.params.confidence,
            ctx: m.endpoint.contextLimitTokens ?? "?",
            inputs: m.endpoint.inputModalities.join("+"),
            free: m.endpoint.pricing.freeVerified ? "yes" : "no",
            "requests 7d": m.stats7d.requests,
            summary: m.headline,
          }));
        out(json ? rows : table(rows), json);
        return 0;
      }
      case "route": {
        const [profile, tier] = args as [ProfileName, TierName];
        if (!PROFILE_NAMES.includes(profile) || !TIER_NAMES.includes(tier)) throw new MeritRouterError("usage", "usage: route <profile> <T1|T2|T3>");
        const p = routingPreview(sy, profile, tier);
        const rows = p.explanations.map((e) => ({ rank: e.rank ?? "-", model: e.endpointId, params: e.totalParametersB ?? "?", via: e.via ?? "", why: e.eligible ? "eligible" : e.reasons.join("; ") }));
        out(json ? p : `size floor ${p.floorB}B${p.forced ? " (forced by override)" : ""}\n${table(rows)}`, json);
        return 0;
      }
      case "worker": {
        sy.recover();
        out(`worker ${sy.owner} running; Ctrl+C to stop`, false);
        // Agents' work is watched in the panel: start it if nothing answers (panel.auto_start).
        void ensurePanel(cfg).then((p) => out(p.detail, false));
        // The service's timers are unref'd; this ref'd timer keeps the worker alive until a signal.
        const keepAlive = setInterval(() => undefined, 60_000);
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        clearInterval(keepAlive);
        return 0;
      }
      case "submit": {
        // Agents are about to work: bring back a panel the user turned off (panel.auto_start permitting).
        await revivePanel(cfg);
        const src = args[0] ?? "-";
        const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
        const parsed = JSON.parse(text) as unknown;
        const tasks = withImportance(Array.isArray(parsed) ? parsed : [parsed], values.importance, values["importance-reason"]);
        const submitted = await sy.submitTasks(tasks, { project: project() });
        if (!values.wait) {
          out(json ? submitted : table(submitted.map((s) => ({ ...s }))), json);
          return 0;
        }
        const r = await sy.awaitResults(submitted.map((s) => s.taskId), { timeoutSeconds: Number(values.timeout ?? cfg.execution.await_max_seconds) });
        out(r, true);
        return r.timedOut ? 2 : 0;
      }
      case "status": {
        const rows = args.length ? sy.getStatus(args, idScope()) : sy.listTasks(undefined, 30, listScope());
        out(json ? rows : table(rows.map((s) => ("profile" in s ? { task: s.taskId, ...(multi ? { project: s.project } : {}), type: s.profile, tier: s.tier ?? "", state: s.state, requests: `${s.modelRequestsUsed}/${s.maxModelRequests ?? "uncapped"}`, goal: s.goal } : { task: s.taskId, state: s.state }))), json);
        return 0;
      }
      case "await": {
        const r = await sy.awaitResults(args, { timeoutSeconds: Number(values.timeout ?? cfg.execution.await_max_seconds) });
        out(r, true);
        return r.timedOut ? 2 : 0;
      }
      case "collect":
        out(sy.collectResults(args), true);
        return 0;
      case "cancel":
        out(sy.cancelTasks(args, idScope()), true);
        return 0;
      case "resume": {
        const id = args[0];
        if (!id) throw new MeritRouterError("usage", "usage: meritrouter resume <session-id|task-id>");
        // A session id continues that session; anything else is a task id. Output is JSON, as before.
        if (sy.sessions.get(id) || (id.startsWith("s_") && !sy.tasks.get(id))) out({ sessionId: id, ...sy.resumeSession(id, idScope()) }, true);
        else out({ taskId: id, state: sy.resumeTask(id, idScope()) }, true);
        return 0;
      }
      case "accept":
      case "reject": {
        const id = args[0];
        if (!id) throw new MeritRouterError("usage", `usage: meritrouter ${cmd} <task id> ${cmd === "reject" ? "--reason" : "[--reason]"} "<why>"`);
        const r = decideTaskAcceptance(sy, id, cmd, { kind: "human", id: cliActor() }, values.reason?.trim() || null, idScope());
        out(json ? r : `${r.taskId}: ${r.decision.decision} by ${r.decision.by.id}; acceptance ${r.acceptanceStatus}`, json);
        return 0;
      }
      case "artifact": {
        const a = sy.artifacts.read(args[0]!);
        if (!a) throw new MeritRouterError("not_found", `unknown artifact ${args[0]}`);
        process.stdout.write(a.content);
        return 0;
      }
      case "qualify": {
        if (args[0] === "status" || !args[0]) {
          await sy.qualifier.gradePending();
          const b = (await import("./admin/insights.js")).qualificationBoard(sy);
          const rows = b.rows.filter((r) => r.stat).map((r) => ({ model: r.endpointId, family: r.family, tier: r.tier, pass: `${r.stat!.passes}/${r.stat!.trials}`, rate: `${Math.round(r.stat!.passRate * 100)}%`, "95% CI": `${Math.round(r.stat!.low * 100)}-${Math.round(r.stat!.high * 100)}%`, qualified: r.stat!.qualified ? "yes" : "no" }));
          out(json ? b : `suite ${b.suiteVersion}; qualification requests today ${b.requestsUsedToday}/${b.dailyAllocation}
${table(rows)}`, json);
          return 0;
        }
        const run = await sy.qualifier.start(args[0], { ...(values.trials ? { trials: Number(values.trials) } : {}) });
        out(json ? run : `started ${run.runId}: ${run.tasks} task(s) for ${run.endpointId}; a running worker executes and grades them (check with \`meritrouter qualify status\`)`, json);
        return 0;
      }
      case "keys":
        return await keysCommand(sy, args, values, json);
      case "run": {
        // Agents are about to work: bring back a panel the user turned off (panel.auto_start permitting).
        await revivePanel(cfg);
        const goal = args.join(" ").trim();
        if (!goal || !values.repo?.length) throw new MeritRouterError("usage", 'usage: meritrouter run "<goal>" --repo <alias> [--repo ...] [--check "<command>"] [--criteria "<text>"] [--wait]');
        const job = await sy.startJob({ goal, project: project(), repositories: values.repo.flatMap((r) => r.split(",")), ...(values.lab ? { lab: values.lab } : {}), ...(values.check ? { checks: values.check } : {}), ...(values.criteria ? { acceptanceCriteria: values.criteria } : {}) });
        if (!values.wait) {
          out(json ? job : `job ${job.taskId} ${job.state}. A worker runs it (meritrouter worker, or the MCP server). Follow with: meritrouter job ${job.taskId}`, json);
          return 0;
        }
        const r = await sy.awaitResults([job.taskId], { timeoutSeconds: Number(values.timeout ?? cfg.supervisor.job_timeout_seconds) });
        out(r, true);
        return r.timedOut ? 2 : 0;
      }
      case "jobs": {
        const rows = jobsView(sy, 50, listScope()).map((j) => ({ job: j.taskId, ...(multi ? { project: j.project } : {}), state: j.state, questions: j.pendingQuestions || "", workers: `${j.children.filter((c) => c.state === "completed").length}/${j.children.length}`, branch: j.branches.map((b) => b.branch).join(", "), goal: j.goal.slice(0, 60) }));
        out(json ? rows : table(rows), json);
        return 0;
      }
      case "job": {
        const j = jobDetail(sy, args[0] ?? "");
        if (!j) throw new MeritRouterError("not_found", `unknown job ${args[0]}`);
        const team = jobTeam(sy, j.taskId)!;
        out(json ? { ...j, team } : [
          `${j.taskId} ${j.state}: ${j.goal}`,
          ...j.branches.map((b) => `branch ${b.branch} in ${b.alias} (${j.parentJobId ? "the parent job integrates it" : `merge with: git merge --no-ff ${b.branch}`})`),
          ...j.children.map((c) => `  ${c.label ?? c.taskId} [${c.profile}] ${c.state}${c.acceptance ? ` / ${c.acceptance}` : ""}`),
          ...j.questions.filter((q) => !q.answer).map((q) => `  QUESTION ${q.id}: ${q.question}${q.options ? ` (${q.options.join(" / ")})` : ""}  -> meritrouter answer ${q.id} "<answer>"`),
          `working document: brain:${j.workingDoc}`,
          ...(j.result ? [`result: ${j.result.stopReason}, acceptance ${j.result.acceptanceStatus}`, j.result.summary] : []),
          ...jobTeamLines(team),
        ].join("\n"), json);
        return 0;
      }
      case "channel": {
        if (!args[0]) throw new MeritRouterError("usage", "usage: meritrouter channel <job-id> [--after <post id>] [--limit <n>] [--kind finding,blocker,interface_contract] [--json]");
        const kinds = values.kind === undefined ? undefined : z.array(z.enum(CHANNEL_KINDS)).min(1).safeParse(values.kind.split(",").map((k) => k.trim()).filter(Boolean));
        if (kinds && !kinds.success) throw new MeritRouterError("usage", `--kind takes ${CHANNEL_KINDS.join(", ")} (comma-separated), got ${JSON.stringify(values.kind)}`);
        const after = countFlag("after", values.after);
        const limit = countFlag("limit", values.limit, 1);
        const c = jobChannel(sy, args[0], { ...(after !== undefined ? { afterId: after } : {}), ...(limit ? { limit } : {}), ...(kinds?.success ? { kinds: kinds.data } : {}) });
        if (!c) throw new MeritRouterError("not_found", `unknown job ${args[0]}`);
        out(json ? c : channelText(c), json);
        return 0;
      }
      case "metrics": {
        const id = args[0];
        if (!id) throw new MeritRouterError("usage", "usage: meritrouter metrics <job-id|task-id> [--json]");
        const m = jobMetrics(sy, id);
        if (!m) throw new MeritRouterError("not_found", `unknown job or task ${id}`);
        out(json ? m : metricsText(m), json);
        return 0;
      }
      case "compare": {
        if (args[0] === "list") {
          const list = comparisons(sy, { limit: countFlag("limit", values.limit, 1) ?? 20 });
          out(json ? list : comparisonsTable(list), json);
          return 0;
        }
        if (args[0] === "show") {
          const c = comparison(sy, args[1] ?? "");
          if (!c) throw new MeritRouterError("not_found", `unknown comparison ${args[1] ?? ""}`);
          out(json ? c : comparisonText(c), json);
          return 0;
        }
        const plan = planComparison(sy, {
          ...(values.eval ? { evalIds: values.eval.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
          ...(values.goals ? { goals: JSON.parse(readFileSync(values.goals, "utf8")) as unknown } : {}),
          ...(values["team-factor"] ? { teamFactor: Number(values["team-factor"]) } : {}),
          ...(values["team-requests"] ? { teamRequests: countFlag("team-requests", values["team-requests"], 1)! } : {}),
        });
        if (!compareRun) {
          out(json ? plan : `${comparisonPlanText(plan)}
${values["dry-run"] ? "dry run: nothing ran" : `nothing ran: add --yes to run it (up to ${plan.plannedRequests} requests)`}`, json);
          return plan.fits ? 0 : 1;
        }
        if (!plan.fits) throw new MeritRouterError("budget", `${comparisonPlanText(plan)}
the planned budget does not fit what is left of today's qualification allocation`);
        if (!json) out(comparisonPlanText(plan), false);
        sy.recover();
        const stop = new AbortController();
        process.once("SIGINT", () => stop.abort());
        const c = await runComparison(sy, plan, { signal: stop.signal, ...(values.timeout ? { timeoutSeconds: countFlag("timeout", values.timeout, 1)! } : {}), ...(json ? {} : { onProgress: (line: string) => out(line, false) }) });
        out(json ? c : comparisonText(c), json);
        return c.status === "finished" ? 0 : 1;
      }
      case "plan": {
        const id = args[0];
        if (!id) throw new MeritRouterError("usage", "usage: meritrouter plan <job-id> [--json]");
        const p = jobPlan(sy, id);
        if (!p) throw new MeritRouterError("not_found", `unknown job ${id}`);
        out(json ? p : planText(p), json);
        return 0;
      }
      case "questions": {
        const rows = sy.questions({ project: listScope() }).map((q) => ({ id: q.id, job: q.taskId, ...(multi ? { project: q.project } : {}), question: q.question, options: q.options?.join(" / ") ?? "" }));
        out(json ? rows : table(rows), json);
        return 0;
      }
      case "answer": {
        sy.answerQuestion(Number(args[0]), args.slice(1).join(" "), "user", idScope());
        out(`answered question ${args[0]}`, json);
        return 0;
      }
      case "brain": {
        const sub = args[0] ?? "ls";
        if (sub === "ls") {
          const rows = (await brainTree(sy, args[1] ?? "", listScope())).map((e) => ({ path: e.path, kind: e.kind, status: e.status ?? "", lines: e.lines, title: e.title ?? "" }));
          out(json ? rows : table(rows), json);
        } else if (sub === "read") process.stdout.write(brainRead(sy, args[1] ?? "", listScope()).content + "\n");
        else if (sub === "search") {
          const rows = (await brainSearch(sy, args.slice(1).join(" "), undefined, listScope())).map((h) => ({ path: h.path, kind: h.kind, snippet: h.snippet }));
          out(json ? rows : table(rows), json);
        } else if (sub === "requests") {
          const rows = brainAccessRequests(sy, "pending", listScope()).map((r) => ({ id: r.id, task: r.taskId ?? "", role: r.role, mode: r.mode, pattern: r.pattern, reason: r.reason }));
          out(json ? rows : table(rows), json);
        } else if (sub === "approve" || sub === "deny") {
          const r = decideBrainAccess(sy, Number(args[1]), sub === "approve", args.slice(2).join(" ") || `${sub}d by the user`, idScope());
          out(`request ${r.id}: ${r.status}`, json);
        } else throw new MeritRouterError("usage", "usage: brain ls [prefix] | read <path> | search <query> | requests | approve|deny <id> [reason]");
        return 0;
      }
      case "budget": {
        const sub = args[0] ?? "list";
        if (sub === "list") {
          const status = values.status === "all" ? undefined : ((values.status ?? "pending") as BudgetRequestStatus);
          if (status && !(BUDGET_REQUEST_STATUSES as readonly string[]).includes(status)) throw new MeritRouterError("usage", `--status is one of ${BUDGET_REQUEST_STATUSES.join(", ")}, or all`);
          const reqs = budgetRequestsView(sy, { ...(status ? { status } : {}), ...(values.job ? { jobId: values.job } : {}), ...(listScope() ? { project: listScope()! } : {}) });
          const rows = reqs.map((r) => ({ id: r.id, task: r.label, job: r.jobId ?? "", status: r.status, asks: r.requests, used: `${r.used}/${r.cap}`, approver: r.approver, granted: r.granted || "", pool: r.pool ? (r.pool.cap === null ? "uncapped" : `${r.pool.available} of ${r.pool.cap}`) : "", reason: r.reason.slice(0, 60) }));
          out(json ? reqs : table(rows), json);
        } else if (sub === "approve" || sub === "deny") {
          const id = Number(args[1]);
          if (!Number.isInteger(id) || id < 1) throw new MeritRouterError("usage", `usage: meritrouter budget ${sub} <id> ${sub === "approve" ? "[--grant N] " : ""}[--reason "<why>"]`);
          const grant = values.grant !== undefined ? Number(values.grant) : null;
          const r = decideBudgetRequest(sy, id, { approve: sub === "approve", grant, reason: values.reason?.trim() || args.slice(2).join(" ") || `${sub === "approve" ? "approved" : "denied"} by the user`, by: { kind: "human", id: cliActor() } }, idScope());
          out(json ? r : `budget request ${r.id}: ${r.status}${r.status === "approved" ? ` (+${r.granted} requests for ${r.taskId})` : ""}`, json);
        } else throw new MeritRouterError("usage", "usage: meritrouter budget list [--status pending|approved|denied|expired|all] [--job <id>] | approve <id> [--grant N] [--reason ...] | deny <id> [--reason ...]");
        return 0;
      }
      case "blame": {
        // The alias is the project's (two projects may both have an `app`).
        const repo = sy.projectContext(project()).repositoryPaths[args[0] ?? ""];
        if (!repo || !args[1]) throw new MeritRouterError("usage", "usage: meritrouter blame <repo-alias> <path> [--ref <branch or commit>]");
        const lines = await blame(repo.path, args[1], values.ref ?? "HEAD");
        const rows = lines.map((l) => ({ line: l.line, agent: l.agent ?? l.authorName, model: l.model ?? "", role: l.role ?? "", commit: l.commit.slice(0, 10), text: l.text.slice(0, 80) }));
        out(json ? lines : table(rows), json);
        return 0;
      }
      case "sessions": {
        const status = statusFlag(values.status);
        const limit = countFlag("limit", values.limit, 1);
        const list = sessionsView(sy, { project: listScope(), ...(status ? { status } : {}), ...(values.task ? { taskId: values.task } : {}), ...(values.job ? { jobId: values.job } : {}), ...(limit ? { limit } : {}) });
        out(json ? list : table(sessionRows(list)), json);
        return 0;
      }
      case "session": {
        const id = args[0];
        if (!id) throw new MeritRouterError("usage", "usage: meritrouter session <id> [--after <seq>] [--limit <n>] [--json]");
        const after = countFlag("after", values.after) ?? 0;
        const limit = countFlag("limit", values.limit, 1);
        const d = sessionDetail(sy, id, { afterSeq: after, ...(limit ? { limit } : {}) });
        if (!d) throw new MeritRouterError("not_found", `unknown session ${id}`);
        out(json ? d : sessionTimeline(d, after), json);
        return 0;
      }
      case "usage":
        out(sy.usage(Date.now() - Number(values.hours ?? 24) * 3_600_000, undefined, listScope()), true);
        return 0;
      default:
        process.stderr.write(`unknown command ${cmd}\n\n${HELP}`);
        return 64;
    }
  } finally {
    await sy.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`meritrouter: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
