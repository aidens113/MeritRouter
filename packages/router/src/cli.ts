#!/usr/bin/env node
import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, DEFAULT_CONFIG_NAME } from "./config/load.js";
import { PROFILE_NAMES, TIER_NAMES, type ProfileName, type TierName } from "./config/schema.js";
import { Switchyard } from "./core/service.js";
import { createCodingRunner } from "./runners/coding/index.js";
import { modelsView, routingPreview } from "./admin/insights.js";
import { SwitchyardError } from "./core/errors.js";

const HELP = `switchyard - delegate bounded tasks to approved free model pools

Usage: switchyard <command> [options]   (global: --config <file>, --json)

Setup
  init [dir]                    write example switchyard.config.yaml and models.yaml
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

Qualification
  qualify <model-id> [--trials n]   run the private eval suite pinned to one model
  qualify status                    leaderboard (grades any finished runs first)
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
    mkdirSync(dir, { recursive: true });
    for (const [src, dst] of [["switchyard.config.example.yaml", DEFAULT_CONFIG_NAME], ["models.example.yaml", "models.yaml"]] as const) {
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
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
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
