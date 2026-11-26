import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseConfig, FakeProvider, makeEnv, open, type Env } from "./helpers.js";
import { MeritRouter } from "../src/core/service.js";
import { MeritRouterError } from "../src/core/errors.js";
import { connectCommand } from "../src/cli/connect.js";
import { inboxCommand } from "../src/cli/inbox.js";
import type { ChannelMessage, SupervisorChannelService } from "../src/core/channel.js";

// supervisor-offload lane D: `meritrouter connect claude|codex` and `meritrouter inbox`.
// Never touches the real user's ~/.codex or ~/.claude: Codex's config.toml and Claude's
// .mcp.json/.claude/settings.json/CLAUDE.md/AGENTS.md are all written under disposable temp
// directories, never the home directory this process actually runs under.

const services: MeritRouter[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A split installation with no project configured yet, so `connect` must create one. */
function splitEnv(): Env {
  return makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: {}, brain: { path: "brain", project: "unconfigured" } }) });
}

function openEnv(env: Env): MeritRouter {
  const sy = open(env, new FakeProvider());
  services.push(sy);
  return sy;
}

describe("connect claude", () => {
  it("creates the project, writes .mcp.json, and appends the CLAUDE.md block; re-running is idempotent and preserves unrelated content", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    // A project directory distinct from the repository (the dogfooding case this repo's own
    // rule forces: `app` may never hold a `.MeritRouter` of its own).
    const projectDir = tempDir("meritrouter-test-projectdir-");
    // Pre-existing, unrelated content that must survive both commands untouched.
    writeFileSync(path.join(env.repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "node", args: ["other.js"] } } }, null, 2));
    writeFileSync(path.join(env.repo, "CLAUDE.md"), "# My project\n\nExisting instructions.\n");

    const first = await connectCommand(sy, "claude", { project: "my-app", repo: [env.repo], "project-dir": projectDir }, path.join(env.dir, "dist"));
    expect(first.createdProject).toBe(true);
    expect(sy.projects.get("my-app")).toBeTruthy();

    const mcp = JSON.parse(readFileSync(path.join(env.repo, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers.other).toEqual({ command: "node", args: ["other.js"] }); // untouched
    expect(mcp.mcpServers.meritrouter!.command).toBe("node");
    expect(mcp.mcpServers.meritrouter!.args).toEqual([path.join(env.dir, "dist", "cli.js"), "mcp", "--config", sy.cfg.configPath, "--project", "my-app"]);

    const claudeMd = readFileSync(path.join(env.repo, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Existing instructions.");
    expect(claudeMd).toContain("<!-- meritrouter:offload:start -->");
    expect((claudeMd.match(/meritrouter:offload:start/g) ?? []).length).toBe(1);

    // Re-run: same project (not recreated), same files, no duplication.
    const second = await connectCommand(sy, "claude", { project: "my-app", repo: [env.repo], "project-dir": projectDir }, path.join(env.dir, "dist"));
    expect(second.createdProject).toBe(false);
    expect(second.mcpConfig.state).toBe("updated");
    expect(second.snippet.state).toBe("updated");
    const claudeMd2 = readFileSync(path.join(env.repo, "CLAUDE.md"), "utf8");
    expect((claudeMd2.match(/meritrouter:offload:start/g) ?? []).length).toBe(1);
    expect(claudeMd2).toContain("Existing instructions.");
  });

  it("installs the three hooks into .claude/settings.json idempotently, keeping unrelated hooks", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    const projectDir = tempDir("meritrouter-test-projectdir-");
    mkdirSync(path.join(env.repo, ".claude"), { recursive: true });
    writeFileSync(
      path.join(env.repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: { tool_name: "Read" }, hooks: [{ type: "command", command: "node some-other-hook.js" }] }] } }, null, 2),
    );

    await connectCommand(sy, "claude", { project: "my-app", repo: [env.repo], "project-dir": projectDir, hooks: true }, path.join(env.dir, "dist"));
    await connectCommand(sy, "claude", { project: "my-app", repo: [env.repo], "project-dir": projectDir, hooks: true }, path.join(env.dir, "dist"));

    const settings = JSON.parse(readFileSync(path.join(env.repo, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const preToolUse = settings.hooks.PreToolUse!;
    expect(preToolUse).toHaveLength(2); // the pre-existing one, plus exactly one of ours
    expect(preToolUse.some((e) => e.hooks[0]!.command.includes("some-other-hook.js"))).toBe(true);
    const ours = preToolUse.filter((e) => e.hooks[0]!.command.includes("pretool-nudge.mjs"));
    expect(ours).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop![0]!.hooks[0]!.command).toContain("stop-inbox-gate.mjs");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain("sessionstart-inbox.mjs");
  });
});

describe("connect codex", () => {
  it("writes [mcp_servers.meritrouter] into config.toml and AGENTS.md, preserving other servers and content; idempotent", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    const projectDir = tempDir("meritrouter-test-projectdir-");
    const codexHome = tempDir("meritrouter-test-codexhome-");
    writeFileSync(path.join(codexHome, "config.toml"), "[mcp_servers.other]\ncommand = 'node'\nargs = ['other.js']\n");
    writeFileSync(path.join(env.repo, "AGENTS.md"), "# Repo agents\n\nExisting rule.\n");
    const priorEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await connectCommand(sy, "codex", { project: "my-app", repo: [env.repo], "project-dir": projectDir }, path.join(env.dir, "dist"));
      const toml1 = readFileSync(path.join(codexHome, "config.toml"), "utf8");
      expect(toml1).toContain("[mcp_servers.other]");
      expect(toml1).toContain("[mcp_servers.meritrouter]");
      expect(toml1).toContain(`'${path.join(env.dir, "dist", "cli.js")}'`);

      await connectCommand(sy, "codex", { project: "my-app", repo: [env.repo], "project-dir": projectDir }, path.join(env.dir, "dist"));
      const toml2 = readFileSync(path.join(codexHome, "config.toml"), "utf8");
      expect((toml2.match(/\[mcp_servers\.meritrouter\]/g) ?? []).length).toBe(1);
      expect(toml2).toContain("[mcp_servers.other]"); // untouched

      const agentsMd = readFileSync(path.join(env.repo, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("Existing rule.");
      expect((agentsMd.match(/meritrouter:offload:start/g) ?? []).length).toBe(1);
    } finally {
      if (priorEnv === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorEnv;
    }
  });

  it("refuses --hooks (Codex has no hook mechanism)", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    await expect(connectCommand(sy, "codex", { project: "my-app", repo: [env.repo], hooks: true }, path.join(env.dir, "dist"))).rejects.toThrow(MeritRouterError);
  });
});

describe("connect validation", () => {
  it("requires --project", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    await expect(connectCommand(sy, "claude", {}, path.join(env.dir, "dist"))).rejects.toThrow(MeritRouterError);
  });

  it("rejects an unknown target", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    await expect(connectCommand(sy, "chatgpt", { project: "my-app" }, path.join(env.dir, "dist"))).rejects.toThrow(MeritRouterError);
  });
});

describe("inbox", () => {
  function fakeMessage(over: Partial<ChannelMessage>): ChannelMessage {
    return { id: "m", taskId: "t1", projectId: "p1", direction: "worker_to_supervisor", kind: "question", body: "body", status: "pending", createdAt: 1_000, ...over };
  }

  it("renders listPendingForSupervisor through an injected fake channel, classifying requests vs. replies", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    const rows: ChannelMessage[] = [
      fakeMessage({ id: "m1", kind: "question", body: "need clarification" }),
      fakeMessage({ id: "m2", kind: "answer", body: "answered a probe", inReplyTo: "probe1" }),
    ];
    let seenScope: string | undefined = "unset";
    const fake: Partial<SupervisorChannelService> = {
      listPendingForSupervisor: (projectScope) => {
        seenScope = projectScope;
        return rows;
      },
    };
    sy.channel = fake as SupervisorChannelService;

    let printed = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = inboxCommand(sy, "my-app", true);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(seenScope).toBe("my-app");
    const parsed = JSON.parse(printed) as Array<{ id: string; waitingOn: string }>;
    expect(parsed).toEqual([
      expect.objectContaining({ id: "m1", waitingOn: "request" }),
      expect.objectContaining({ id: "m2", waitingOn: "reply" }),
    ]);
  });

  it("returns 0 on an empty inbox", async () => {
    const env = splitEnv();
    const sy = openEnv(env);
    sy.channel = { listPendingForSupervisor: () => [] } as unknown as SupervisorChannelService;
    let printed = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = inboxCommand(sy, undefined, false);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(printed).toContain("inbox empty");
  });
});

// Sanity: the hook scripts this test's "installs the three hooks" case points at actually exist
// in the shipped integrations/ folder (a path mistake there would only show up at runtime).
describe("integrations/ scripts exist", () => {
  it("ships the three Claude Code hook scripts", () => {
    const root = path.resolve(__dirname, "..", "integrations", "claude-code", "hooks");
    for (const name of ["pretool-nudge.mjs", "stop-inbox-gate.mjs", "sessionstart-inbox.mjs"]) {
      expect(existsSync(path.join(root, name))).toBe(true);
    }
  });
});
