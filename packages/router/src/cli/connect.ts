import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../core/service.js";
import { createProject } from "../admin/insights.js";
import { MeritRouterError } from "../core/errors.js";

// `meritrouter connect claude|codex`: one command that (1) ensures the named project exists, (2)
// registers this MCP server with the client, and (3) appends an idempotent offload reminder to
// the repository's CLAUDE.md / AGENTS.md. See docs/setup.md#4-connect-an-mcp-client and
// docs/working/supervisor-offload.md (lane D). `--hooks` additionally installs the opt-in Claude
// Code hooks under `.claude/settings.json`; Codex has no hook mechanism, so `--hooks` with
// `codex` is a usage error rather than a silent no-op.

export interface ConnectFlags {
  project?: string;
  /** `--repo <dir>`: the repository this connection works in. Reuses the existing multi-valued
   * `--repo` flag, but `connect` takes a bare directory, not `alias=path` (there is exactly one
   * repository per connection, aliased `app`). */
  repo?: string[];
  /** The project's own store directory (`<project-dir>/.MeritRouter`). Defaults to the repository
   * directory, but MUST be given separately when the repository may never hold a `.MeritRouter`
   * of its own (this very checkout, per the 2026-10-26 project rule: dogfooding passes
   * `--project-dir D:/MeritRouterProjects/<slug>`). */
  "project-dir"?: string;
  hooks?: boolean;
}

const START = "<!-- meritrouter:offload:start -->";
const END = "<!-- meritrouter:offload:end -->";

function offloadSnippet(target: "claude" | "codex"): string {
  const inbox = "`meritrouter inbox --json`";
  return [
    START,
    "## MeritRouter offload",
    "",
    "This repository is connected to a MeritRouter MCP server. Prefer delegating bounded,",
    "disjoint-file work to its free workers. Use the MCP `delegate` and `await` tools,",
    "answer worker messages with `reply`, and verify reports before accepting them.",
    "",
    `Before ending a turn or a session, check ${inbox} (or the \`inbox\` MCP tool) for worker`,
    "questions awaiting an answer and finished reports awaiting review, and clear them first.",
    ...(target === "claude"
      ? ["The optional Claude Code Stop hook checks for unanswered worker messages."]
      : []),
    END,
  ].join("\n");
}

/** Replace the marked block if present, else append it (with a separating blank line). Never
 * touches anything outside the markers. */
function mergeMarkedBlock(filePath: string, block: string): "updated" | "created" | "appended" {
  const exists = existsSync(filePath);
  const prior = exists ? readFileSync(filePath, "utf8") : "";
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(prior)) {
    writeFileSync(filePath, prior.replace(re, block), "utf8");
    return "updated";
  }
  const sep = prior.length && !prior.endsWith("\n\n") ? (prior.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(filePath, `${prior}${sep}${block}\n`, "utf8");
  return exists ? "appended" : "created";
}

/** Merge `mcpServers.meritrouter` into a Claude Code `.mcp.json`, keeping every other server. */
function mergeMcpJson(filePath: string, cliPath: string, configPath: string, project: string): "updated" | "created" {
  const existed = existsSync(filePath);
  let doc: { mcpServers?: Record<string, unknown> } = {};
  if (existed) {
    try {
      doc = JSON.parse(readFileSync(filePath, "utf8")) as typeof doc;
    } catch (error) {
      throw new MeritRouterError("usage", `cannot parse existing ${filePath} as JSON: ${(error as Error).message}`);
    }
  }
  doc.mcpServers = { ...(doc.mcpServers ?? {}), meritrouter: { command: "node", args: [cliPath, "mcp", "--config", configPath, "--project", project] } };
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return existed ? "updated" : "created";
}

/** A TOML literal string (single-quoted): no escaping needed, so a Windows backslash path is
 * written byte-for-byte (see docs/setup.md#4-connect-an-mcp-client-claude-code-codex-chatgpt /
 * `codex mcp add`'s own generated form, which this mirrors). */
const tomlLiteral = (s: string): string => `'${s.replace(/'/g, "")}'`;

/** Merge `[mcp_servers.meritrouter]` into Codex's `config.toml` as plain text: replace that one
 * section if it already exists (from a header line up to the next top-level `[` or EOF), else
 * append it. Verified against docs/setup.md's own documented Codex format (`codex mcp add`
 * writes `[mcp_servers.<name>]` with `command`/`args`); this repo has no TOML dependency, so the
 * merge is line-based rather than a full parse. */
function mergeCodexToml(filePath: string, cliPath: string, configPath: string, project: string): "updated" | "created" {
  const existed = existsSync(filePath);
  const prior = existed ? readFileSync(filePath, "utf8") : "";
  const section = [
    "[mcp_servers.meritrouter]",
    `command = ${tomlLiteral("node")}`,
    `args = [${[cliPath, "mcp", "--config", configPath, "--project", project].map(tomlLiteral).join(", ")}]`,
    "",
  ].join("\n");
  const headerRe = /^\[mcp_servers\.meritrouter\]\s*$/m;
  const m = headerRe.exec(prior);
  if (!m) {
    const sep = prior.length && !prior.endsWith("\n") ? "\n\n" : prior.length ? "\n" : "";
    writeFileSync(filePath, `${prior}${sep}${section}`, "utf8");
    return existed ? "updated" : "created";
  }
  const start = m.index;
  const nextHeader = /^\[/m;
  const rest = prior.slice(start + m[0].length);
  const next = nextHeader.exec(rest);
  const end = next ? start + m[0].length + next.index : prior.length;
  writeFileSync(filePath, `${prior.slice(0, start)}${section}${prior.slice(end).replace(/^\n+/, "")}`, "utf8");
  return "updated";
}

/** Each managed hook's script, relative to this package's `dist/` (so it resolves the same way
 * whether run from the checkout or an installed tarball). */
const HOOK_SCRIPTS = {
  PreToolUse: "pretool-nudge.mjs",
  Stop: "stop-inbox-gate.mjs",
  SessionStart: "sessionstart-inbox.mjs",
} as const;

/** Merge the three opt-in hooks into `.claude/settings.json`: for each event, drop any prior
 * entry whose command names one of our managed scripts (so re-running `connect --hooks` updates
 * rather than duplicates), then append the current one. Every other hook entry, and every other
 * top-level setting, is left exactly as found. */
function mergeClaudeHooks(filePath: string, integrationsRoot: string, cliPath: string, configPath: string, project: string): "updated" | "created" {
  const existed = existsSync(filePath);
  let doc: Record<string, unknown> = {};
  if (existed) {
    try {
      doc = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new MeritRouterError("usage", `cannot parse existing ${filePath} as JSON: ${(error as Error).message}`);
    }
  }
  const hooks = { ...((doc.hooks as Record<string, unknown[]> | undefined) ?? {}) };
  const isOurs = (entry: unknown, script: string): boolean => {
    const h = (entry as { hooks?: Array<{ command?: string }> } | undefined)?.hooks;
    return Array.isArray(h) && h.some((x) => typeof x.command === "string" && x.command.includes(script));
  };
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const scriptPath = (name: string) => path.join(integrationsRoot, "claude-code", "hooks", name);
  const entryFor = (event: keyof typeof HOOK_SCRIPTS): Record<string, unknown> => {
    const script = scriptPath(HOOK_SCRIPTS[event]);
    const args = event === "PreToolUse" ? [] : [cliPath, configPath, project];
    const command = `node ${quote(script)}${args.map((a) => ` ${quote(a)}`).join("")}`;
    return event === "PreToolUse" ? { matcher: { tool_name: "Write|Edit|MultiEdit|Bash" }, hooks: [{ type: "command", command }] } : { hooks: [{ type: "command", command }] };
  };
  for (const event of Object.keys(HOOK_SCRIPTS) as Array<keyof typeof HOOK_SCRIPTS>) {
    const script = HOOK_SCRIPTS[event];
    const existing = ((hooks[event] as unknown[]) ?? []).filter((e) => !isOurs(e, script));
    hooks[event] = [...existing, entryFor(event)];
  }
  doc = { ...doc, hooks };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return existed ? "updated" : "created";
}

/** The `integrations/` folder shipped beside this package (works from the source checkout and
 * from an installed tarball, where `package.json`'s `files` must include it; see package.json). */
export function integrationsRoot(cliDistDir: string): string {
  // dist/cli.js's sibling `../integrations` when installed; the source checkout's
  // `packages/router/integrations` otherwise (dist and integrations are siblings under the
  // package root either way).
  return path.resolve(cliDistDir, "..", "integrations");
}

export interface ConnectResult {
  slug: string;
  repoDir: string;
  projectDir: string;
  createdProject: boolean;
  configPath: string;
  mcpConfig: { path: string; state: "updated" | "created" };
  snippet: { path: string; state: "updated" | "created" | "appended" };
  hooks?: { path: string; state: "updated" | "created" };
}

/**
 * `meritrouter connect claude|codex --project <slug> [--repo <dir>] [--project-dir <dir>]
 * [--hooks]`. `sy` is already open on the config this connection should point at
 * (`sy.cfg.configPath`); `cliDistDir` is `dist/` (the directory holding `cli.js`), used to locate
 * both the invocation this writes and the `integrations/` scripts `--hooks` points at.
 */
export async function connectCommand(sy: MeritRouter, target: string, flags: ConnectFlags, cliDistDir: string): Promise<ConnectResult> {
  if (target !== "claude" && target !== "codex") throw new MeritRouterError("usage", 'usage: meritrouter connect claude|codex --project <slug> [--repo <dir>] [--project-dir <dir>] [--hooks]');
  if (flags.hooks && target === "codex") throw new MeritRouterError("usage", "--hooks installs Claude Code hooks; Codex has no hook mechanism, so pass --hooks only with connect claude");
  const slug = flags.project;
  if (!slug) throw new MeritRouterError("usage", "connect needs --project <slug>");
  if (flags.repo && flags.repo.length > 1) throw new MeritRouterError("usage", "connect takes at most one --repo <dir> (the repository this connection works in)");

  const repoDir = path.resolve(flags.repo?.[0] ?? process.cwd());
  const projectDir = path.resolve(flags["project-dir"] ?? repoDir);
  const cliPath = path.join(cliDistDir, "cli.js");
  const configPath = sy.cfg.configPath;

  let createdProject = false;
  if (!sy.projects.get(slug)) {
    const r = await createProject(sy, { slug, directory: projectDir, repositories: { app: { path: repoDir } } });
    if (!r.ok) throw new MeritRouterError("usage", `project ${slug} could not be created:\n  ${r.errors.join("\n  ")}`);
    createdProject = true;
  }

  const result: ConnectResult = {
    slug,
    repoDir,
    projectDir,
    createdProject,
    configPath,
    mcpConfig: { path: "", state: "created" },
    snippet: { path: "", state: "created" },
  };

  if (target === "claude") {
    const mcpPath = path.join(repoDir, ".mcp.json");
    result.mcpConfig = { path: mcpPath, state: mergeMcpJson(mcpPath, cliPath, configPath, slug) };
    const claudeMdPath = path.join(repoDir, "CLAUDE.md");
    result.snippet = { path: claudeMdPath, state: mergeMarkedBlock(claudeMdPath, offloadSnippet("claude")) };
    if (flags.hooks) {
      const settingsPath = path.join(repoDir, ".claude", "settings.json");
      result.hooks = { path: settingsPath, state: mergeClaudeHooks(settingsPath, integrationsRoot(cliDistDir), cliPath, configPath, slug) };
    }
  } else {
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    const tomlPath = path.join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true });
    result.mcpConfig = { path: tomlPath, state: mergeCodexToml(tomlPath, cliPath, configPath, slug) };
    const agentsMdPath = path.join(repoDir, "AGENTS.md");
    result.snippet = { path: agentsMdPath, state: mergeMarkedBlock(agentsMdPath, offloadSnippet("codex")) };
  }

  return result;
}

export function connectText(r: ConnectResult): string {
  return [
    `project ${r.slug}${r.createdProject ? " (created)" : ""}: repo ${r.repoDir}, store ${r.projectDir}/.MeritRouter`,
    `MCP config ${r.mcpConfig.state}: ${r.mcpConfig.path}`,
    `offload snippet ${r.snippet.state}: ${r.snippet.path}`,
    ...(r.hooks ? [`Claude Code hooks ${r.hooks.state}: ${r.hooks.path}`] : []),
    "Reconnect your client, then check with `meritrouter inbox` once workers are dispatched.",
  ].join("\n");
}
