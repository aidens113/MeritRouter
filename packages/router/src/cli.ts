#!/usr/bin/env node
import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, DEFAULT_CONFIG_NAME } from "./config/load.js";
import { PROFILE_NAMES, TIER_NAMES, type ProfileName, type TierName } from "./config/schema.js";
import { Switchyard } from "./core/service.js";
import { createCodingRunner } from "./runners/coding/index.js";
import { z } from "zod";
import { brainAccessRequests, brainRead, brainSearch, brainTree, decideBrainAccess, jobDetail, jobsView, modelsView, routingPreview, sessionDetail, sessionsView, type SessionDetail, type SessionView } from "./admin/insights.js";
import { blame } from "./attribution/index.js";
import { SwitchyardError } from "./core/errors.js";
import { SessionStatusSchema, type SessionEvent, type SessionEventData } from "./sessions/events.js";
import type { ResolvedConfig } from "./config/load.js";
import { backupStorage, restoreStorage } from "./operations/backup.js";
import { Daemon, acquireDaemonLock, logsDirFor, readDaemonLock } from "./operations/daemon.js";
import { ServiceActionSchema, ServicePlatformSchema, describeServiceSteps, runServiceSteps, servicePlan } from "./operations/service.js";

const HELP = `switchyard - delegate bounded tasks to approved free model pools

Usage: switchyard <command> [options]   (global: --config <file>, --json)

Setup
  init [dir] [--preset <name>]  write switchyard.config.yaml and models.yaml
                                presets: claude-code (default), standalone-free,
                                standalone-hybrid, standalone-paid
  doctor                        check config, gateway, admin access, models, and repositories
  models [--all]                list models with status and eligibility
  models scan                   scan FreeLLMAPI's catalog and sync per-model chains
  models show <id>              full analysis of one model
  models confirm <id> [--params <B>] [--active <B>]   accept or set parameter counts
  models enable|disable <id>    force a model on or off
  route <profile> <tier>        preview which models would serve a task type at a tier

Tasks
  worker                        run the worker loop until interrupted
  submit <file|-> [--wait] [--timeout s]   submit task JSON (object or array)
  status [ids...]               task status (recent tasks when no ids)
  await <ids...> [--timeout s]  wait for results
  collect <ids...>              print finished results
  cancel <ids...>               cancel tasks
  resume <id>                   requeue an interrupted task
  artifact <ref>                print an artifact
  usage [--hours n]             requests, tokens, and outcomes

Agent sessions (every model call and tool call, in order)
  sessions [--status s[,s]] [--task id] [--job id] [--limit n]   list sessions, newest first
                                statuses: running, completed, failed, interrupted, cancelled
  session <id> [--after seq] [--limit n]   timeline (--json prints the raw page)

Paid keys (direct routes; secrets are encrypted at rest)
  keys [list]                   keys with billing class, spend, balance, cap
  keys add <provider> [--label x] [--billing paid_credits|paid_postpaid|trial|free_tier] [--balance usd] [--cap usd]
                                reads the secret from SWITCHYARD_NEW_KEY
  keys enable|disable|remove <id>
  keys spend                    spend against budgets

Standalone jobs (a SwitchYard supervisor plans, delegates, verifies, integrates)
  run "<goal>" --repo <alias> [--check "<cmd>"] [--criteria "<text>"] [--wait]
  jobs                          list jobs
  job <id>                      job status, workers, branch, questions
  questions                     questions supervisors are waiting on
  answer <id> "<answer>"        answer one

Brain (shared knowledge) and attribution
  brain ls [prefix] | read <path> | search <query>
  brain requests | approve <id> [reason] | deny <id> [reason]
  blame <repo-alias> <path> [--ref <branch>]   which agent and model wrote each line

Qualification
  qualify <model-id> [--trials n]   run the private eval suite pinned to one model
  qualify status                    leaderboard (grades any finished runs first)

Operations (storage.durability: normal | full sets SQLite's synchronous level)
  backup <dir> [--include-master-key]   online snapshot of the database, session logs, and
                                artifacts into a new directory (never worktrees)
  restore <dir> [--force]       restore a backup; refused while a worker holds live leases,
                                and over existing state unless --force (which moves it aside)
  daemon [--max-restarts n] [--window s] [--max-delay s]   run the worker and restart it on
                                failure with backoff; logs under <storage>/logs/
  service install|uninstall|status [--name n] [--dry-run]   run the daemon at logon as a
                                systemd user unit, launchd agent, or Windows scheduled task
`;

function out(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "(none)";
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, width[i]).padEnd(width[i]!)).join("  ");
  return [line(cols), line(width.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}

// ---------- agent sessions ----------

const CountFlag = z.coerce.number().int().nonnegative();

/** Parse a numeric flag with zod; a bad value is a usage error, not NaN. */
function countFlag(name: string, value: string | undefined, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const r = CountFlag.min(min).safeParse(value);
  if (!r.success) throw new SwitchyardError("usage", `--${name} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  return r.data;
}

/** `--status completed,failed` -> validated statuses. */
function statusFlag(value: string | undefined) {
  if (value === undefined) return undefined;
  const r = z.array(SessionStatusSchema).min(1).safeParse(value.split(",").map((s) => s.trim()).filter(Boolean));
  if (!r.success) throw new SwitchyardError("usage", `--status takes ${SessionStatusSchema.options.join(", ")} (comma-separated), got ${JSON.stringify(value)}`);
  return r.data.length === 1 ? r.data[0]! : r.data;
}

const oneLine = (text: string, max = 120): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);
const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
const compact = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? ""));

function messageText(m: SessionEventData<"message">["message"]): string {
  if (m.role === "tool") return `(${m.tool_call_id}) ${m.content}`;
  if (m.role === "assistant") return [m.content ?? "", m.tool_calls?.length ? `-> ${m.tool_calls.map((c) => c.function.name).join(", ")}` : ""].filter(Boolean).join(" ");
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
}

/** The name/ok column: what `session_events.name` and `ok` hold for the event. */
function eventName(e: SessionEvent): { name: string; ok?: boolean } {
  switch (e.type) {
    case "started": return { name: e.data.role };
    case "message": return { name: e.data.message.role };
    case "model_request": return { name: e.data.purpose };
    case "model_response": return { name: e.data.endpointId, ok: true };
    case "model_error": return { name: e.data.code ?? "error", ok: false };
    case "tool_intent": return { name: e.data.name };
    case "tool_outcome": return { name: e.data.name, ok: e.data.ok };
    case "ended": return { name: e.data.status };
    default: return { name: "" };
  }
}

/** Fit the name/ok cell to `width`, shortening the name but never the ok/FAIL marker. */
function nameCell(e: SessionEvent, width: number): string {
  const { name, ok } = eventName(e);
  const mark = ok === undefined ? "" : ok ? " ok" : " FAIL";
  const room = width - mark.length;
  return `${name.length > room ? `${name.slice(0, room - 3)}...` : name}${mark}`.padEnd(width);
}

function eventSummary(e: SessionEvent): string {
  switch (e.type) {
    case "started": {
      const d = e.data;
      return [`agent ${d.agentLabel}`, d.profile && `profile ${d.profile}`, d.tier && `tier ${d.tier}`, d.taskId && `task ${d.taskId}`, d.parentSessionId && `parent ${d.parentSessionId}`, d.previousSessionId && `retries ${d.previousSessionId}`].filter(Boolean).join(", ");
    }
    case "message": return `#${e.data.index} ${messageText(e.data.message)}`;
    case "model_request": {
      const d = e.data;
      return [`${d.messageCount} msgs`, `max ${d.maxTokens} tok`, d.tools.length ? `tools ${d.tools.join(",")}` : "", d.responseFormat ? `format ${d.responseFormat}` : ""].filter(Boolean).join(", ");
    }
    case "model_response": {
      const d = e.data;
      const head = [d.finishReason ?? "?", `in ${d.usage.inputTokens ?? "?"} / out ${d.usage.outputTokens ?? "?"} tok`, d.attempts.length > 1 ? `${d.attempts.length} attempts` : ""].filter(Boolean).join(", ");
      const body = d.toolCalls.length ? `-> ${d.toolCalls.map((c) => c.function.name).join(", ")}` : (d.content ?? "");
      return body ? `${head}: ${body}` : head;
    }
    case "model_error": return `${e.data.status !== null ? `HTTP ${e.data.status}: ` : ""}${e.data.message}`;
    case "tool_intent": return `[${e.data.sideEffect}${e.data.idempotent ? ", idempotent" : ""}] ${compact(e.data.args)}`;
    case "tool_outcome": return `intent #${e.data.intentSeq}${e.data.truncated ? " (truncated)" : ""}: ${e.data.output}`;
    case "note": return e.data.data === undefined ? e.data.text : `${e.data.text} ${compact(e.data.data)}`;
    case "workspace": return e.data.repos.map((r) => `${r.alias} ${r.branch ?? "-"} @ ${(r.head ?? r.baseCommit ?? "?").slice(0, 10)}`).join("; ") || "(no repositories)";
    case "ended": return e.data.stopReason;
    default: return "";
  }
}

function sessionLine(s: SessionView): string {
  return `${s.id} ${s.agentLabel} (${s.role}) ${s.status}${s.stopReason ? `: ${s.stopReason}` : ""}`;
}

/** A terminal timeline: header, one line per event (seq, time, type, name/ok, summary), paging hint. */
function sessionTimeline(d: SessionDetail, after: number): string {
  const s = d.session;
  const header = [
    sessionLine(s),
    [s.taskId && `task ${s.taskId}${s.taskLabel ? ` "${s.taskLabel}"` : ""}`, s.jobId && `job ${s.jobId}`, s.profile && `profile ${s.profile}`, s.tier && `tier ${s.tier}`].filter(Boolean).join("  ") || "(no task)",
    `started ${stamp(s.createdAt)}  ${s.endedAt ? `ended after ${duration(s.durationMs)}` : `running for ${duration(s.durationMs)}`}  model requests ${s.modelRequests}  tool calls ${s.toolCalls}  events ${s.lastSeq}`,
    ...(s.parentSessionId ? [`parent ${s.parentSessionId}`] : []),
    ...(s.previousSessionId ? [`retries ${s.previousSessionId}`] : []),
    `log ${s.logPath}`,
  ];
  const seqWidth = Math.max(3, String(s.lastSeq).length);
  const nameWidth = 32;
  const rows = d.events.map((e) => [String(e.seq).padStart(seqWidth), clock(e.at), e.type.padEnd(14), nameCell(e, nameWidth), oneLine(eventSummary(e))].join("  "));
  const cols = ["seq".padStart(seqWidth), "time".padEnd(12), "type".padEnd(14), "name/ok".padEnd(nameWidth), "summary"].join("  ");
  const lastShown = d.events.at(-1)?.seq ?? after;
  return [
    ...header,
    "",
    cols,
    ...(rows.length ? rows : [`(no events after seq ${after})`]),
    ...d.corrupt.map((c) => `CORRUPT ${c.line ? `line ${c.line}` : "log"}: ${c.error}${c.excerpt ? ` [${oneLine(c.excerpt, 60)}]` : ""}`),
    ...(d.hasMore ? [`more events: switchyard session ${s.id} --after ${lastShown}`] : []),
    ...(d.children.length ? ["", "delegated sessions:", ...d.children.map((c) => `  ${sessionLine(c)}`)] : []),
    ...(d.taskSessions.length > 1 ? ["", "sessions of this task:", ...d.taskSessions.map((t) => `  ${t.id === s.id ? "*" : " "} ${sessionLine(t)}`)] : []),
  ].join("\n").trimEnd();
}

// ---------- operations: backup, restore, daemon, service ----------

interface OperationsFlags {
  force?: boolean;
  "include-master-key"?: boolean;
  "dry-run"?: boolean;
  "max-restarts"?: string;
  window?: string;
  "max-delay"?: string;
  name?: string;
}

const CLI_PATH = fileURLToPath(import.meta.url);

async function operationsCommand(cmd: string, args: string[], values: OperationsFlags, cfg: ResolvedConfig, json: boolean): Promise<number> {
  switch (cmd) {
    case "backup": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard backup <dir> [--include-master-key]");
      const m = await backupStorage({ storageDir: cfg.storageDir, targetDir: args[0], includeMasterKey: values["include-master-key"] ?? false });
      out(json ? m : [
        `backed up ${cfg.storageDir} to ${path.resolve(args[0])}`,
        `schema ${m.schemaVersion}; ${m.tasks} task(s), ${m.sessions} session(s) with ${m.sessionLogs} log(s), ${m.artifacts} artifact(s)`,
        m.includesMasterKey ? "includes the vault master key: keep this backup private" : "the vault master key is not included; paid keys need SWITCHYARD_MASTER_KEY or the original .master-key to decrypt",
        ...m.missing.map((f) => `MISSING ${f}`),
      ].join("\n"), json);
      return m.missing.length ? 1 : 0;
    }
    case "restore": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard restore <dir> [--force]");
      const r = restoreStorage({ backupDir: args[0], storageDir: cfg.storageDir, force: values.force ?? false });
      out(json ? r : [
        `restored ${path.resolve(args[0])} (taken ${r.manifest.createdAt}) into ${r.storageDir}; schema ${r.schemaVersion}`,
        ...(r.previousMovedTo ? [`previous state moved to ${r.previousMovedTo}`] : []),
        ...(r.leasesReleased ? [`${r.leasesReleased} task(s) were running at backup time; the next worker recovers them`] : []),
      ].join("\n"), json);
      return 0;
    }
    case "daemon": {
      const seconds = (name: string, v: string | undefined) => (v === undefined ? undefined : countFlag(name, v, 1)! * 1000);
      const maxRestarts = countFlag("max-restarts", values["max-restarts"], 1);
      const windowMs = seconds("window", values.window);
      const maxDelayMs = seconds("max-delay", values["max-delay"]);
      const logsDir = logsDirFor(cfg.storageDir);
      const release = acquireDaemonLock(logsDir, cfg.configPath);
      const daemon = new Daemon({
        command: process.execPath,
        args: [...process.execArgv, CLI_PATH, "worker", "--config", cfg.configPath],
        cwd: path.dirname(cfg.configPath),
        logsDir,
        policy: { ...(maxRestarts ? { maxRestarts } : {}), ...(windowMs ? { windowMs } : {}), ...(maxDelayMs ? { maxDelayMs } : {}) },
      });
      const stop = () => void daemon.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      out(`daemon ${process.pid} supervising the worker; logs in ${logsDir}; Ctrl+C to stop`, false);
      try {
        const r = await daemon.run();
        out(json ? r : `daemon ${r.reason}: ${r.detail}`, json);
        return r.reason === "gave_up" ? 1 : 0;
      } finally {
        release();
      }
    }
    case "service": {
      const action = ServiceActionSchema.safeParse(args[0]);
      if (!action.success) throw new SwitchyardError("usage", "usage: switchyard service install|uninstall|status [--name n] [--dry-run]");
      const platform = ServicePlatformSchema.safeParse(process.platform);
      if (!platform.success) throw new SwitchyardError("usage", `service install supports linux, macOS, and Windows, not ${process.platform}`);
      const user = userInfo();
      const plan = servicePlan({
        platform: platform.data,
        ...(values.name ? { name: values.name } : {}),
        nodePath: process.execPath,
        cliPath: CLI_PATH,
        configPath: cfg.configPath,
        workingDir: path.dirname(cfg.configPath),
        storageDir: cfg.storageDir,
        logsDir: logsDirFor(cfg.storageDir),
        homeDir: homedir(),
        ...(user.uid >= 0 ? { uid: user.uid } : {}),
        ...(platform.data === "win32" ? { windowsUser: process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user.username}` : user.username } : {}),
      });
      if (values["dry-run"]) {
        out(json ? { action: action.data, plan } : describeServiceSteps(plan, action.data), json);
        return 0;
      }
      const r = runServiceSteps(plan, action.data);
      const lock = action.data === "status" ? readDaemonLock(logsDirFor(cfg.storageDir)) : null;
      out(json ? { ...r, daemon: lock } : [
        ...r.results.map((x) => `${x.step.kind === "run" ? [x.step.command, ...x.step.args].join(" ") : x.output}${x.code ? ` (exit ${x.code})` : ""}${x.step.kind === "run" && x.output.trim() ? `\n${x.output.trimEnd()}` : ""}`),
        ...(action.data === "status" ? [lock ? `daemon pid ${lock.pid} ${lock.alive ? "running" : "not running (stale lock)"} since ${lock.startedAt}` : "no daemon lock for this storage directory"] : []),
        ...(action.data === "install" && r.ok ? plan.notes : []),
      ].join("\n"), json);
      return r.ok ? 0 : 1;
    }
    default:
      throw new SwitchyardError("usage", `unknown operations command ${cmd}`);
  }
}

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
      force: { type: "boolean", default: false },
      "include-master-key": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "max-restarts": { type: "string" },
      window: { type: "string" },
      "max-delay": { type: "string" },
      name: { type: "string" },
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
  if (cmd === "backup" || cmd === "restore" || cmd === "daemon" || cmd === "service") return operationsCommand(cmd, args, values, cfg, json);
  const worker = cmd === "worker" || (cmd === "submit" && values.wait);
  const sy = new Switchyard(cfg, { worker, coding: createCodingRunner(cfg) });
  try {
    switch (cmd) {
      case "doctor": {
        const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
        checks.push({ check: "config", ok: true, detail: cfg.configPath });
        checks.push({ check: "gateway key", ok: sy.client.name !== "unconfigured", detail: cfg.gateway.api_key_env });
        try {
          await sy.health.refresh(0);
          checks.push({ check: "gateway reachable", ok: sy.health.snapshot().length > 0 || sy.client.name !== "unconfigured", detail: `${sy.health.snapshot().length} provider(s) reported` });
        } catch (err) {
          checks.push({ check: "gateway reachable", ok: false, detail: (err as Error).message });
        }
        checks.push({ check: "admin token", ok: sy.admin !== null, detail: cfg.gateway.admin_token_env });
        if (sy.admin) {
          try {
            await sy.admin.listProfiles();
            checks.push({ check: "admin API", ok: true, detail: "profiles readable" });
          } catch (err) {
            checks.push({ check: "admin API", ok: false, detail: (err as Error).message });
          }
        }
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
        const tasks = Array.isArray(parsed) ? parsed : [parsed];
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
      case "resume":
        out({ taskId: args[0], state: sy.resumeTask(args[0]!) }, true);
        return 0;
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
        // Paid provider keys (direct routes). FreeLLMAPI keys are managed in the panel.
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
        out(json ? j : [
          `${j.taskId} ${j.state}: ${j.goal}`,
          ...j.branches.map((b) => `branch ${b.branch} in ${b.alias} (merge with: git merge --no-ff ${b.branch})`),
          ...j.children.map((c) => `  ${c.label ?? c.taskId} [${c.profile}] ${c.state}${c.acceptance ? ` / ${c.acceptance}` : ""}`),
          ...j.questions.filter((q) => !q.answer).map((q) => `  QUESTION ${q.id}: ${q.question}${q.options ? ` (${q.options.join(" / ")})` : ""}  -> switchyard answer ${q.id} "<answer>"`),
          `working document: brain:${j.workingDoc}`,
          ...(j.result ? [`result: ${j.result.stopReason}, acceptance ${j.result.acceptanceStatus}`, j.result.summary] : []),
        ].join("\n"), json);
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
        const rows = list.map((s) => ({
          session: s.id,
          status: s.status,
          role: s.role,
          agent: s.agentLabel,
          task: s.taskLabel ?? s.taskId ?? "",
          job: s.jobId ?? "",
          requests: s.modelRequests,
          tools: s.toolCalls,
          events: s.lastSeq,
          started: stamp(s.createdAt),
          duration: duration(s.durationMs),
          reason: s.stopReason ?? "",
        }));
        out(json ? list : table(rows), json);
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
