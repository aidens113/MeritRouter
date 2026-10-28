import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { providerHealth } from "../providers/health.js";
import { builtinProvider } from "../providers/registry.js";
import { keyAvailability } from "./keys.js";
import { panelBuildCheck } from "../operations/panel.js";
import type { RepositoryPreparation } from "../projects/repository-setup.js";
import { folderState, preparationHint } from "../workspaces/repository-prepare.js";
import { stamp } from "./terminal.js";
import { webBackendText, webStatusText } from "../admin/web-search.js";
import { SEARCH_SERVICE_IDS } from "../web/services.js";

// `meritrouter doctor`: configuration, provider keys (one check per provider), secrets held in the
// config file, models, and per project its repositories and brain folders. It reads only stored
// state and never calls a provider.

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  check: string;
  /** False only for `fail`; a warning does not fail doctor. */
  ok: boolean;
  level: CheckLevel;
  detail: string;
}

/** What the last discovery run that covered a provider found. */
export interface LastListing {
  at: number;
  status: "listed" | "no_key" | "disabled" | "failed";
  kept: number;
  errors: number;
  /** Error messages from the scan that ran that discovery, when there was one. */
  messages: string[];
}

const DiscoveryEventSchema = z.object({
  providers: z.array(z.object({ provider: z.string(), status: z.enum(["listed", "no_key", "disabled", "failed"]), kept: z.number(), errors: z.number() })),
});

/** The latest stored listing result per provider (from `provider_discovery` events and scans). */
export function lastListings(sy: MeritRouter, providers: Iterable<string>): Map<string, LastListing> {
  const wanted = new Set(providers);
  const found = new Map<string, LastListing>();
  const rows = sy.db.prepare("SELECT ts, data_json FROM events WHERE task_id IS NULL AND type = 'provider_discovery' ORDER BY id DESC LIMIT 500").all() as Array<{ ts: number; data_json: string | null }>;
  const scans = sy.db.prepare("SELECT started_at, finished_at, summary_json FROM scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 50").all() as Array<{ started_at: number; finished_at: number; summary_json: string | null }>;
  const ScanErrors = z.object({ errors: z.array(z.string()) });
  for (const row of rows) {
    if (found.size === wanted.size) break;
    let data: z.infer<typeof DiscoveryEventSchema>;
    try {
      const parsed = DiscoveryEventSchema.safeParse(JSON.parse(row.data_json ?? "null"));
      if (!parsed.success) continue;
      data = parsed.data;
    } catch {
      continue;
    }
    const scan = scans.find((s) => s.started_at <= row.ts && row.ts <= s.finished_at);
    let errors: string[] = [];
    if (scan?.summary_json) {
      try {
        const s = ScanErrors.safeParse(JSON.parse(scan.summary_json));
        if (s.success) errors = s.data.errors;
      } catch {
        // A malformed summary only loses the messages.
      }
    }
    for (const p of data.providers) {
      if (!wanted.has(p.provider) || found.has(p.provider)) continue;
      found.set(p.provider, { at: row.ts, status: p.status, kept: p.kept, errors: p.errors, messages: errors.filter((e) => e.startsWith(`${p.provider} (`) || e.startsWith(`${p.provider}:`)) });
    }
  }
  return found;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One check per provider that has a key or is configured: keys, health, last listing, models. */
export function providerChecks(sy: MeritRouter): DoctorCheck[] {
  const cfg = sy.cfg;
  const declared = Object.keys(cfg.providers.byId);
  const paid = Object.keys(cfg.paid.providers);
  const all = keyAvailability(sy);
  const ids = [...new Set([...all.map((k) => k.cred.provider), ...declared, ...paid])].sort();
  const listings = lastListings(sy, ids);
  const endpoints = sy.catalog.endpoints();
  const checks: DoctorCheck[] = [];
  for (const id of ids) {
    const provider = sy.providers.provider(id);
    const keys = all.filter((k) => k.cred.provider === id);
    const parts: string[] = [];
    let level = "ok" as CheckLevel;
    const raise = (l: CheckLevel) => {
      if (l === "fail" || (l === "warn" && level === "ok")) level = l;
    };
    if (!provider) {
      checks.push({ check: `provider ${id}`, ok: false, level: "fail", detail: `${plural(keys.length, "key")} for a provider that is not configured: add providers.${id} with base_url, or remove the keys` });
      continue;
    }
    if (!provider.enabled) {
      checks.push({ check: `provider ${id}`, ok: true, level: "ok", detail: "disabled in the config" });
      continue;
    }
    // Keys and their state.
    if (provider.noKey) parts.push("no key needed");
    else if (!keys.length) {
      parts.push(paid.includes(id) && !declared.includes(id) ? "no key: paid.models on this provider cannot run (meritrouter keys add)" : "no key: add one with meritrouter keys add, or under providers in the config");
      raise(paid.includes(id) && !declared.includes(id) ? "warn" : "fail");
    } else {
      const by = (s: string | null) => keys.filter((k) => k.availability.reason === s);
      const usable = keys.filter((k) => k.availability.reason !== "unusable");
      const counts = [`${plural(keys.length, "key")}`, `${by(null).length} available`];
      for (const [reason, name] of [["cooling", "cooling down"], ["exhausted", "at a rate limit"], ["free_quota", "out of free daily quota"], ["limit", "at a configured limit"], ["auth_invalid", "invalid"], ["out_of_credits", "out of credits"], ["unusable", "unusable"]] as const) {
        const ks = by(reason);
        if (!ks.length) continue;
        const until = ks.map((k) => k.availability.until).filter((t): t is number => t !== null);
        const named = reason === "auth_invalid" || reason === "out_of_credits" || reason === "unusable" ? ` (${ks.map((k) => `${k.cred.ref}${k.cred.last4 ? ` ...${k.cred.last4}` : ""}${reason === "unusable" ? `: ${k.availability.detail}` : ""}`).join(", ")})` : "";
        counts.push(`${ks.length} ${name}${until.length ? ` until ${stamp(Math.min(...until))}` : ""}${named}`);
      }
      parts.push(counts.join(", "));
      const health = providerHealth(provider, keys.map((k) => k.cred), sy.providers.keys, { limits: sy.providers.limits }).status;
      if (!usable.length || health.status === "unknown" || health.status === "invalid") raise("fail");
      else if (health.status === "rate_limited" || by("auth_invalid").length || by("out_of_credits").length || by("unusable").length) raise("warn");
    }
    // Last listing (paid-only providers are not listed: their models come from paid.models).
    const builtin = builtinProvider(id);
    const fromPaidOnly = paid.includes(id) && !declared.includes(id) && (!builtin || builtin.baseUrl.replace(/\/+$/, "") !== provider.baseUrl);
    const last = listings.get(id);
    if (fromPaidOnly) parts.push("models from paid.models (not listed)");
    else if (!last) {
      parts.push("never listed: run meritrouter models scan");
      if (keys.length || provider.noKey) raise("warn");
    } else if (last.status === "listed") parts.push(`last listing ${stamp(last.at)}: ${plural(last.kept, "model")}`);
    else if (last.status === "failed") {
      parts.push(`last listing ${stamp(last.at)} FAILED${last.messages.length ? `: ${last.messages.join("; ")}` : ` (${plural(last.errors, "error")})`}`);
      raise("warn");
    } else parts.push(`last listing ${stamp(last.at)}: ${last.status === "no_key" ? "no usable key" : "disabled"}`);
    const mine = endpoints.filter((e) => e.providerId === id);
    parts.push(`${mine.filter((e) => e.status === "active").length} of ${plural(mine.length, "stored model")} active`);
    checks.push({ check: `provider ${id}`, ok: level !== "fail", level, detail: parts.join("; ") });
  }
  return checks;
}

/** A warning per config file entry that holds a literal secret (`api_key`). */
export function literalSecretChecks(sy: MeritRouter): DoctorCheck[] {
  const found: string[] = [];
  for (const [id, entry] of Object.entries(sy.cfg.providers.byId)) {
    for (const [n, k] of entry.keys.entries()) if (k.api_key !== undefined) found.push(`providers.${id}.keys[${n}]${k.label ? ` (${k.label})` : ""}`);
  }
  for (const id of SEARCH_SERVICE_IDS) if (sy.cfg.web.search[id]?.api_key !== undefined) found.push(`web.search.${id}`);
  if (!found.length) return [];
  return [{ check: "secrets in config", ok: true, level: "warn", detail: `${sy.cfg.configPath} holds a literal api_key at ${found.join(", ")}: use api_key_env, or move the key to the encrypted vault (meritrouter keys add)` }];
}

/**
 * Per project: each repository is a usable git repository, and its brain folders exist (missing
 * folders are a warning: they are created when the project is created or first written; a missing
 * mount is a failure). With `prepared` (the CLI prepares repositories before doctor runs), a
 * repository MeritRouter just created or set up is ok with what was done, and one it could not set
 * up fails with the fix; without it, a folder not set up yet is a warning saying what will happen.
 */
export function projectChecks(sy: MeritRouter, slug: string, prepared: RepositoryPreparation[] = []): DoctorCheck[] {
  const ctx = sy.projects.require(slug);
  const archived = sy.projects.rows().find((r) => r.id === slug)?.archivedAt != null;
  const checks: DoctorCheck[] = [];
  const repos = Object.entries(ctx.repositoryPaths);
  checks.push({ check: `project ${slug}`, ok: true, level: "ok", detail: `${ctx.project.name}${ctx.project.legacy ? " (single-project config)" : ""}${archived ? "; archived" : ""}; ${plural(repos.length, "repository")}` });
  for (const [alias, repo] of repos) {
    const check = `${slug} repo ${alias}`;
    const prep = prepared.find((p) => p.project === slug && p.alias === alias)?.result;
    if (prep && !prep.ok) {
      checks.push({ check, ok: false, level: "fail", detail: prep.message });
      continue;
    }
    if (prep?.ok && prep.action !== "unchanged") {
      checks.push({ check, ok: true, level: "ok", detail: `${repo.path} (${prep.message.replace(/^MeritRouter /, "")})` });
      continue;
    }
    const state = folderState(repo.path);
    if (state === "repository" || state === "unknown") checks.push({ check, ok: true, level: "ok", detail: repo.path });
    else if (state === "file") checks.push({ check, ok: false, level: "fail", detail: `${repo.path} is a file, not a folder: choose a folder in the project settings` });
    else checks.push({ check, ok: true, level: "warn", detail: `${repo.path}: ${preparationHint(state)} when MeritRouter starts` });
  }
  const brain = sy.brainFor(slug);
  const dirs = ["working", "decisions"].map((d) => `projects/${slug}/${d}`);
  const missing = existsSync(brain.root) ? dirs.filter((d) => !existsSync(brain.resolve(d).abs)) : dirs;
  checks.push(
    missing.length
      ? { check: `${slug} brain`, ok: true, level: "warn", detail: `${existsSync(brain.root) ? `missing ${missing.join(", ")}` : `no brain repository yet at ${brain.root}`}: created when the project is created or first written` }
      : { check: `${slug} brain`, ok: true, level: "ok", detail: `${brain.root} (projects/${slug}/)` },
  );
  // Global mounts are checked once (see doctorChecks), except in a single-project config.
  const isGlobal = (m: { prefix: string; path: string }) => sy.cfg.brain.mounts.some((g) => g.prefix === m.prefix && g.path === m.path);
  for (const m of ctx.brain.mounts) {
    if (!ctx.project.legacy && isGlobal(m)) continue;
    const abs = brain.resolve(m.prefix).abs;
    const ok = existsSync(abs);
    checks.push({ check: `${slug} brain mount ${m.prefix}`, ok, level: ok ? "ok" : "fail", detail: ok ? abs : `${abs} does not exist` });
  }
  return checks;
}

/**
 * Every doctor check, in display order; `projects` limits the per-project checks (default: every
 * project); `prepared` is what preparing the repositories just did (see `projectChecks`).
 */
export function doctorChecks(sy: MeritRouter, opts: { projects?: string[]; prepared?: RepositoryPreparation[] } = {}): DoctorCheck[] {
  const cfg = sy.cfg;
  const checks: DoctorCheck[] = [{ check: "config", ok: true, level: "ok", detail: cfg.configPath }];
  const usable = sy.providers.credentials().list().filter((c) => c.unusableReason === null);
  checks.push(
    usable.length
      ? { check: "provider keys", ok: true, level: "ok", detail: `${plural(usable.length, "usable key")}: ${[...new Set(usable.map((c) => c.provider))].join(", ")}` }
      : { check: "provider keys", ok: false, level: "fail", detail: "none: add one with meritrouter keys add <provider> --billing <class>, under providers in the config, or in the panel's Provider keys page" },
  );
  checks.push(...providerChecks(sy), ...literalSecretChecks(sy));
  const eps = sy.catalog.endpoints();
  const active = eps.filter((e) => e.status === "active").length;
  checks.push({ check: "models", ok: active > 0, level: active > 0 ? "ok" : "fail", detail: `${active} active of ${eps.length}${eps.length ? "" : ": run meritrouter models scan once a key is added"}` });
  // A fresh split installation starts with no projects (and so no primary) until one is created.
  const primary = sy.projects.slugs().length ? sy.projects.primary : undefined;
  if (!primary) checks.push({ check: "projects", ok: true, level: "warn", detail: "none yet: create one with meritrouter projects create <slug> --directory <path>, or the panel's New project page" });
  if (primary && !primary.project.legacy) {
    for (const m of sy.cfg.brain.mounts) {
      const abs = sy.brain.resolve(m.prefix).abs;
      const ok = existsSync(abs);
      checks.push({ check: `brain mount ${m.prefix}`, ok, level: ok ? "ok" : "fail", detail: ok ? abs : `${abs} does not exist` });
    }
  }
  checks.push(...webChecks(sy));
  // A panel build older than the router's: the panel bundles the router, so it shows old behaviour until rebuilt.
  const panel = panelBuildCheck();
  checks.push({ check: "panel build", ok: panel.ok, level: panel.ok ? "ok" : "warn", detail: panel.ok ? panel.detail : `${panel.detail} (pnpm -r build, then restart the panel)` });
  for (const slug of opts.projects ?? sy.projects.slugs()) checks.push(...projectChecks(sy, slug, opts.prepared));
  return checks;
}

/**
 * Web search for agents: the backend pool and fetch chain with each backend's state, or how to
 * turn it on. Off (by choice or for lack of any key) is not a failure; a backend named in the
 * config without a key is a warning (it is skipped), and so is a pool where no backend can serve
 * right now.
 */
export function webChecks(sy: MeritRouter): DoctorCheck[] {
  // Split installations keep web state per project; with no project yet there is nothing to read.
  if (sy.layout === "split" && !sy.projects.slugs().length) {
    return [{ check: "web search", ok: true, level: "ok", detail: sy.cfg.web.enabled ? "checked per project once one exists" : "off (web.enabled: false)" }];
  }
  const s = sy.web.status();
  const out: DoctorCheck[] = [];
  if (!sy.cfg.web.enabled) out.push({ check: "web search", ok: true, level: "ok", detail: "off (web.enabled: false)" });
  else if (!s.on) out.push({ check: "web search", ok: true, level: "ok", detail: `off: ${s.reason}. To give agents web search, add an ollama-cloud key (meritrouter keys add ollama-cloud), a Tavily, Brave, or Exa key (meritrouter keys add tavily, or the panel's Provider keys page), or web.search.searxng.base_url` });
  else {
    const serving = s.search.some((v) => v.status === "healthy");
    out.push({ check: "web search", ok: true, level: serving ? "ok" : "warn", detail: serving ? webStatusText(s) : `no search backend can serve now: ${s.search.filter((v) => v.configured).map(webBackendText).join("; ")}` });
  }
  for (const w of s.warnings) out.push({ check: "web search backend", ok: true, level: "warn", detail: w });
  return out;
}

/** Doctor's terminal text: one line per check, details never truncated. */
export function doctorText(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.check.length));
  return checks.map((c) => `${(c.level === "ok" ? "ok" : c.level === "warn" ? "WARN" : "FAIL").padEnd(4)}  ${c.check.padEnd(width)}  ${c.detail}`).join("\n");
}
