#!/usr/bin/env node
import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, DEFAULT_CONFIG_NAME } from "./config/load.js";
import { PROFILE_NAMES, TIER_NAMES, type ProfileName, type TierName } from "./config/schema.js";
import { Switchyard } from "./core/service.js";
import { createCodingRunner } from "./runners/coding/index.js";
import { z } from "zod";
import { brainAccessRequests, brainRead, brainSearch, brainTree, CHANNEL_KINDS, decideBrainAccess, decideTaskAcceptance, jobChannel, jobDetail, jobMetrics, jobPlan, jobsView, jobTeam, modelsView, routingPreview, sessionDetail, sessionsView } from "./admin/insights.js";
import { comparison, comparisons, planComparison, runComparison } from "./qualification/comparison.js";
import { blame } from "./attribution/index.js";
import { SwitchyardError } from "./core/errors.js";
import { countFlag, statusFlag, withImportance } from "./cli/args.js";
import { HELP } from "./cli/help.js";
import { channelText, jobTeamLines } from "./cli/job-team-text.js";
import { comparisonPlanText, comparisonsTable, comparisonText, metricsText } from "./cli/metrics-text.js";
import { operationsCommand } from "./cli/operations.js";
import { planText } from "./cli/plan-text.js";
import { sessionRows, sessionTimeline } from "./cli/session-text.js";
import { out, table } from "./cli/terminal.js";

// The `switchyard` command: argument parsing and dispatch. Terminal rendering lives in src/cli/.

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

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
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
      status: { type: "string" },
      task: { type: "string" },
      job: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      reason: { type: "string" },
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = values.json ?? false;

  if (cmd === "init") {
    const dir = path.resolve(args[0] ?? ".");
    const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
    const preset = values.preset ?? "claude-code";
    const presetFile = path.join("presets", `${preset}.yaml`);
    if (!existsSync(path.join(examples, presetFile))) throw new SwitchyardError("usage", `unknown preset ${preset}; choose claude-code, standalone-free, standalone-hybrid, or standalone-paid`);
    mkdirSync(dir, { recursive: true });
    for (const [src, dst] of [[presetFile, DEFAULT_CONFIG_NAME], ["models.example.yaml", "models.yaml"]] as const) {
      const target = path.join(dir, dst);
      if (existsSync(target)) out(`kept existing ${target}`, false);
      else {
        copyFileSync(path.join(examples, src), target);
        out(`wrote ${target}`, false);
      }
    }
    return 0;
  }

  const cfg = loadConfig(values.config);
  // Operations work on the storage directory directly and must not open a Switchyard (restore
  // replaces the database; the daemon's worker runs in a child process).
  if (cmd === "backup" || cmd === "restore" || cmd === "daemon" || cmd === "service") return operationsCommand(cmd, args, values, cfg, json, CLI_PATH);
  const compareRun = cmd === "compare" && args[0] !== "list" && args[0] !== "show" && values.yes && !values["dry-run"];
  const worker = cmd === "worker" || (cmd === "submit" && values.wait) || compareRun;
  const sy = new Switchyard(cfg, { worker, coding: createCodingRunner(cfg) });
  try {
    switch (cmd) {
      case "doctor": {
        const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
        checks.push({ check: "config", ok: true, detail: cfg.configPath });
        const usableKeys = sy.providers.credentials().list().filter((c) => c.unusableReason === null);
        checks.push({ check: "provider keys", ok: usableKeys.length > 0, detail: usableKeys.length ? `${usableKeys.length} usable key(s): ${[...new Set(usableKeys.map((c) => c.provider))].join(", ")}` : "none: add keys under providers in the config" });
        const eps = sy.catalog.endpoints();
        checks.push({ check: "models", ok: eps.some((e) => e.status === "active"), detail: `${eps.filter((e) => e.status === "active").length} active of ${eps.length}` });
        for (const [alias, repo] of Object.entries(cfg.repositoryPaths)) checks.push({ check: `repo ${alias}`, ok: existsSync(path.join(repo.path, ".git")), detail: repo.path });
        out(json ? checks : table(checks.map((c) => ({ "": c.ok ? "ok" : "FAIL", check: c.check, detail: c.detail }))), json);
        return checks.every((c) => c.ok) ? 0 : 1;
      }
      case "models": {
        const sub = args[0];
        if (sub === "scan") {
          out(await sy.scan(), true);
          return 0;
        }
        if (sub === "show") {
          const m = modelsView(sy).find((x) => x.endpoint.id === args[1]);
          if (!m) throw new SwitchyardError("not_found", `unknown model ${args[1]}`);
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
        if (!PROFILE_NAMES.includes(profile) || !TIER_NAMES.includes(tier)) throw new SwitchyardError("usage", "usage: route <profile> <T1|T2|T3>");
        const p = routingPreview(sy, profile, tier);
        const rows = p.explanations.map((e) => ({ rank: e.rank ?? "-", model: e.endpointId, params: e.totalParametersB ?? "?", via: e.via ?? "", why: e.eligible ? "eligible" : e.reasons.join("; ") }));
        out(json ? p : `size floor ${p.floorB}B${p.forced ? " (forced by override)" : ""}\n${table(rows)}`, json);
        return 0;
      }
      case "worker": {
        sy.recover();
        out(`worker ${sy.owner} running; Ctrl+C to stop`, false);
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
        const src = args[0] ?? "-";
        const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
        const parsed = JSON.parse(text) as unknown;
        const tasks = withImportance(Array.isArray(parsed) ? parsed : [parsed], values.importance, values["importance-reason"]);
        const submitted = await sy.submitTasks(tasks);
        if (!values.wait) {
          out(json ? submitted : table(submitted.map((s) => ({ ...s }))), json);
          return 0;
        }
        const r = await sy.awaitResults(submitted.map((s) => s.taskId), { timeoutSeconds: Number(values.timeout ?? cfg.execution.await_max_seconds) });
        out(r, true);
        return r.timedOut ? 2 : 0;
      }
      case "status": {
        const rows = args.length ? sy.getStatus(args) : sy.listTasks(undefined, 30);
        out(json ? rows : table(rows.map((s) => ("profile" in s ? { task: s.taskId, type: s.profile, tier: s.tier ?? "", state: s.state, requests: `${s.modelRequestsUsed}/${s.maxModelRequests}`, goal: s.goal } : { task: s.taskId, state: s.state }))), json);
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
        out(sy.cancelTasks(args), true);
        return 0;
      case "resume": {
        const id = args[0];
        if (!id) throw new SwitchyardError("usage", "usage: switchyard resume <session-id|task-id>");
        // A session id continues that session; anything else is a task id. Output is JSON, as before.
        if (sy.sessions.get(id) || (id.startsWith("s_") && !sy.tasks.get(id))) out({ sessionId: id, ...sy.resumeSession(id) }, true);
        else out({ taskId: id, state: sy.resumeTask(id) }, true);
        return 0;
      }
      case "accept":
      case "reject": {
        const id = args[0];
        if (!id) throw new SwitchyardError("usage", `usage: switchyard ${cmd} <task id> ${cmd === "reject" ? "--reason" : "[--reason]"} "<why>"`);
        const r = decideTaskAcceptance(sy, id, cmd, { kind: "human", id: cliActor() }, values.reason?.trim() || null);
        out(json ? r : `${r.taskId}: ${r.decision.decision} by ${r.decision.by.id}; acceptance ${r.acceptanceStatus}`, json);
        return 0;
      }
      case "artifact": {
        const a = sy.artifacts.read(args[0]!);
        if (!a) throw new SwitchyardError("not_found", `unknown artifact ${args[0]}`);
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
        out(json ? run : `started ${run.runId}: ${run.tasks} task(s) for ${run.endpointId}; a running worker executes and grades them (check with \`switchyard qualify status\`)`, json);
        return 0;
      }
      case "keys": {
        // Provider keys in the vault (the `keys` commands are reworked in P3).
        const sub = args[0] ?? "list";
        if (sub === "list") {
          const rows = sy.spend.summary().keys.map((k) => ({ id: k.id, provider: k.provider, label: k.label, billing: k.billingClass, enabled: k.enabled ? "yes" : "no", key: `...${k.last4}`, "spent 30d": `$${k.spent30d.toFixed(4)}`, balance: k.remainingBalanceUsd === null ? "" : `$${k.remainingBalanceUsd.toFixed(2)}`, cap: k.remainingCapUsd === null ? "" : `$${k.remainingCapUsd.toFixed(2)}` }));
          out(json ? rows : table(rows), json);
          return 0;
        }
        if (sub === "add") {
          const provider = args[1];
          const secret = process.env.SWITCHYARD_NEW_KEY;
          if (!provider || !secret) throw new SwitchyardError("usage", "usage: SWITCHYARD_NEW_KEY=<secret> switchyard keys add <provider> [--label x] [--billing paid_credits] [--balance 10] [--cap 20]  (the secret is read from the environment so it never appears in shell history)");
          const k = sy.vault.add({
            provider,
            secret,
            label: values.label ?? "",
            ...(values.billing ? { billingClass: values.billing as "paid_credits" } : {}),
            ...(values.balance ? { prepaidBalanceUsd: Number(values.balance) } : {}),
            ...(values.cap ? { monthlyCapUsd: Number(values.cap) } : {}),
          });
          out(`added key ${k.id} for ${provider} (...${k.last4})`, json);
          return 0;
        }
        if (sub === "disable" || sub === "enable") {
          sy.vault.update(Number(args[1]), { enabled: sub === "enable" });
          out(`key ${args[1]} ${sub}d`, json);
          return 0;
        }
        if (sub === "remove") {
          sy.vault.remove(Number(args[1]));
          out(`key ${args[1]} removed`, json);
          return 0;
        }
        if (sub === "spend") {
          out(sy.spend.summary(), true);
          return 0;
        }
        throw new SwitchyardError("usage", "usage: keys list|add|enable|disable|remove|spend");
      }
      case "run": {
        const goal = args.join(" ").trim();
        if (!goal || !values.repo?.length) throw new SwitchyardError("usage", 'usage: switchyard run "<goal>" --repo <alias> [--repo ...] [--check "<command>"] [--criteria "<text>"] [--wait]');
        const job = await sy.startJob({ goal, repositories: values.repo.flatMap((r) => r.split(",")), ...(values.check ? { checks: values.check } : {}), ...(values.criteria ? { acceptanceCriteria: values.criteria } : {}) });
        if (!values.wait) {
          out(json ? job : `job ${job.taskId} ${job.state}. A worker runs it (switchyard worker, or the MCP server). Follow with: switchyard job ${job.taskId}`, json);
          return 0;
        }
        const r = await sy.awaitResults([job.taskId], { timeoutSeconds: Number(values.timeout ?? cfg.supervisor.job_timeout_seconds) });
        out(r, true);
        return r.timedOut ? 2 : 0;
      }
      case "jobs": {
        const rows = jobsView(sy).map((j) => ({ job: j.taskId, state: j.state, questions: j.pendingQuestions || "", workers: `${j.children.filter((c) => c.state === "completed").length}/${j.children.length}`, branch: j.branches.map((b) => b.branch).join(", "), goal: j.goal.slice(0, 60) }));
        out(json ? rows : table(rows), json);
        return 0;
      }
      case "job": {
        const j = jobDetail(sy, args[0] ?? "");
        if (!j) throw new SwitchyardError("not_found", `unknown job ${args[0]}`);
        const team = jobTeam(sy, j.taskId)!;
        out(json ? { ...j, team } : [
          `${j.taskId} ${j.state}: ${j.goal}`,
          ...j.branches.map((b) => `branch ${b.branch} in ${b.alias} (${j.parentJobId ? "the parent job integrates it" : `merge with: git merge --no-ff ${b.branch}`})`),
          ...j.children.map((c) => `  ${c.label ?? c.taskId} [${c.profile}] ${c.state}${c.acceptance ? ` / ${c.acceptance}` : ""}`),
          ...j.questions.filter((q) => !q.answer).map((q) => `  QUESTION ${q.id}: ${q.question}${q.options ? ` (${q.options.join(" / ")})` : ""}  -> switchyard answer ${q.id} "<answer>"`),
          `working document: brain:${j.workingDoc}`,
          ...(j.result ? [`result: ${j.result.stopReason}, acceptance ${j.result.acceptanceStatus}`, j.result.summary] : []),
          ...jobTeamLines(team),
        ].join("\n"), json);
        return 0;
      }
      case "channel": {
        if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard channel <job-id> [--after <post id>] [--limit <n>] [--kind finding,blocker,interface_contract] [--json]");
        const kinds = values.kind === undefined ? undefined : z.array(z.enum(CHANNEL_KINDS)).min(1).safeParse(values.kind.split(",").map((k) => k.trim()).filter(Boolean));
        if (kinds && !kinds.success) throw new SwitchyardError("usage", `--kind takes ${CHANNEL_KINDS.join(", ")} (comma-separated), got ${JSON.stringify(values.kind)}`);
        const after = countFlag("after", values.after);
        const limit = countFlag("limit", values.limit, 1);
        const c = jobChannel(sy, args[0], { ...(after !== undefined ? { afterId: after } : {}), ...(limit ? { limit } : {}), ...(kinds?.success ? { kinds: kinds.data } : {}) });
        if (!c) throw new SwitchyardError("not_found", `unknown job ${args[0]}`);
        out(json ? c : channelText(c), json);
        return 0;
      }
      case "metrics": {
        const id = args[0];
        if (!id) throw new SwitchyardError("usage", "usage: switchyard metrics <job-id|task-id> [--json]");
        const m = jobMetrics(sy, id);
        if (!m) throw new SwitchyardError("not_found", `unknown job or task ${id}`);
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
          if (!c) throw new SwitchyardError("not_found", `unknown comparison ${args[1] ?? ""}`);
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
        if (!plan.fits) throw new SwitchyardError("budget", `${comparisonPlanText(plan)}
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
        if (!id) throw new SwitchyardError("usage", "usage: switchyard plan <job-id> [--json]");
        const p = jobPlan(sy, id);
        if (!p) throw new SwitchyardError("not_found", `unknown job ${id}`);
        out(json ? p : planText(p), json);
        return 0;
      }
      case "questions": {
        const rows = sy.questions().map((q) => ({ id: q.id, job: q.taskId, question: q.question, options: q.options?.join(" / ") ?? "" }));
        out(json ? rows : table(rows), json);
        return 0;
      }
      case "answer": {
        sy.answerQuestion(Number(args[0]), args.slice(1).join(" "));
        out(`answered question ${args[0]}`, json);
        return 0;
      }
      case "brain": {
        const sub = args[0] ?? "ls";
        if (sub === "ls") {
          const rows = (await brainTree(sy, args[1] ?? "")).map((e) => ({ path: e.path, kind: e.kind, status: e.status ?? "", lines: e.lines, title: e.title ?? "" }));
          out(json ? rows : table(rows), json);
        } else if (sub === "read") process.stdout.write(brainRead(sy, args[1] ?? "").content + "\n");
        else if (sub === "search") {
          const rows = (await brainSearch(sy, args.slice(1).join(" "))).map((h) => ({ path: h.path, kind: h.kind, snippet: h.snippet }));
          out(json ? rows : table(rows), json);
        } else if (sub === "requests") {
          const rows = brainAccessRequests(sy, "pending").map((r) => ({ id: r.id, task: r.taskId ?? "", role: r.role, mode: r.mode, pattern: r.pattern, reason: r.reason }));
          out(json ? rows : table(rows), json);
        } else if (sub === "approve" || sub === "deny") {
          const r = decideBrainAccess(sy, Number(args[1]), sub === "approve", args.slice(2).join(" ") || `${sub}d by the user`);
          out(`request ${r.id}: ${r.status}`, json);
        } else throw new SwitchyardError("usage", "usage: brain ls [prefix] | read <path> | search <query> | requests | approve|deny <id> [reason]");
        return 0;
      }
      case "blame": {
        const repo = cfg.repositoryPaths[args[0] ?? ""];
        if (!repo || !args[1]) throw new SwitchyardError("usage", "usage: switchyard blame <repo-alias> <path> [--ref <branch or commit>]");
        const lines = await blame(repo.path, args[1], values.ref ?? "HEAD");
        const rows = lines.map((l) => ({ line: l.line, agent: l.agent ?? l.authorName, model: l.model ?? "", role: l.role ?? "", commit: l.commit.slice(0, 10), text: l.text.slice(0, 80) }));
        out(json ? lines : table(rows), json);
        return 0;
      }
      case "sessions": {
        const status = statusFlag(values.status);
        const limit = countFlag("limit", values.limit, 1);
        const list = sessionsView(sy, { ...(status ? { status } : {}), ...(values.task ? { taskId: values.task } : {}), ...(values.job ? { jobId: values.job } : {}), ...(limit ? { limit } : {}) });
        out(json ? list : table(sessionRows(list)), json);
        return 0;
      }
      case "session": {
        const id = args[0];
        if (!id) throw new SwitchyardError("usage", "usage: switchyard session <id> [--after <seq>] [--limit <n>] [--json]");
        const after = countFlag("after", values.after) ?? 0;
        const limit = countFlag("limit", values.limit, 1);
        const d = sessionDetail(sy, id, { afterSeq: after, ...(limit ? { limit } : {}) });
        if (!d) throw new SwitchyardError("not_found", `unknown session ${id}`);
        out(json ? d : sessionTimeline(d, after), json);
        return 0;
      }
      case "usage":
        out(sy.usage(Date.now() - Number(values.hours ?? 24) * 3_600_000), true);
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
    process.stderr.write(`switchyard: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
