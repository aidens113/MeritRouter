import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { sessionDetail, sessionsView } from "../src/admin/sessions.js";
import { sessionTimeline } from "../src/cli/session-text.js";
import { openProjectStores, scopesFor } from "../src/admin/project-reads.js";
import { baseConfig, FakeProvider, makeEnv, open, summarizeTask, type Env } from "./helpers.js";

// A split installation (storage.layout split) reads a project's sessions, artifacts, and task
// results through that project's OWN store, never through the installation store directly
// (`sy.sessions`/`sy.cfg.storageDir`), which is what `meritrouter session <id> --project <slug>`
// used before this fix: a correct header (counted from the project's own `sessions` row) but an
// empty log and "(no events after seq 0)" because the event log was read from the wrong
// directory. See src/admin/session-project-scope.ts (scopedSessionTimeline) and the CLI's
// `artifact`, `job`, `plan`, `metrics`, `channel` commands (src/cli.ts).

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-split-cli-")));
  dirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const one = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** A split installation with one project ("alpha"), a completed fake-provider task, and its session. */
async function setup() {
  const alpha = gitRepo();
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: alpha, repositories: { app: { path: alpha } } } } }) });
  envs.push(env);
  const sy = open(env, new FakeProvider(), { worker: true });
  services.push(sy);
  await sy.createSplitProject({ slug: "alpha", directory: alpha });
  const [submitted] = await sy.submitTasks([summarizeTask({ label: "probe" })], { project: "alpha" });
  const taskId = submitted!.taskId;
  const result = await sy.awaitResults([taskId], { timeoutSeconds: 30 });
  const stores = sy.projectStores("alpha");
  const sessionId = stores.sessions!.forTask(taskId)[0]!.id;
  return { sy, taskId, sessionId, result };
}

describe("split layout: CLI reads go through the project's own store", () => {
  it("a completed task's session carries its events, read through the owning project", async () => {
    const { sy, taskId, sessionId, result } = await setup();
    expect(result.completed, JSON.stringify(sy.getStatus([taskId], "alpha"))).toHaveLength(1);

    // The CLI's `session <id> --project alpha` path (src/cli.ts -> sessionDetail).
    const detail = sessionDetail(sy, sessionId, { project: "alpha" });
    expect(detail).not.toBeNull();
    expect(detail!.timelineUnavailable).toBeNull();
    expect(detail!.events.length).toBeGreaterThan(0);
    expect(detail!.session.lastSeq).toBeGreaterThan(0);
    expect(detail!.events.length).toBe(detail!.session.lastSeq);

    // The terminal rendering must not regress into "(no events after seq 0)".
    const text = sessionTimeline(detail!, 0);
    expect(text).not.toContain("(no events after seq 0)");
    expect(text).toContain(`model requests`);

    // Without an explicit project, the session is still located (searched across projects).
    const detailNoProject = sessionDetail(sy, sessionId);
    expect(detailNoProject!.events.length).toBe(detail!.events.length);
  }, 60_000);

  it("the sessions list (meritrouter sessions) also reflects the project's own store", async () => {
    const { sessionId, sy } = await setup();
    const list = sessionsView(sy, { project: "alpha" });
    expect(list.some((s) => s.id === sessionId)).toBe(true);
    expect(list.find((s) => s.id === sessionId)!.lastSeq).toBeGreaterThan(0);
  }, 60_000);

  it("an artifact written in a split project is read back through that project's own store (meritrouter artifact)", async () => {
    const { sy, taskId } = await setup();
    const stores = sy.projectStores("alpha");
    const ref = stores.artifacts.write({ taskId, kind: "note", label: "evidence", content: "split evidence content" });

    // Mirrors the CLI's `artifact <ref>` fix: scan each project's own store with readScoped.
    let found: { content: Buffer } | undefined;
    for (const p of scopesFor(sy, undefined)) {
      const opened = openProjectStores(sy, p);
      if (!opened.ok) continue;
      try { found = opened.stores.artifacts.readScoped(ref, p); break; } catch { continue; }
    }
    expect(found).toBeDefined();
    expect(found!.content.toString("utf8")).toBe("split evidence content");
  }, 60_000);
});
