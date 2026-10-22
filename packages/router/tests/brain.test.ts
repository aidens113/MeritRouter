import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess, type Principal } from "../src/brain/access.js";
import { openDatabase } from "../src/storage/db.js";
import { parseConfig } from "../src/config/load.js";
import type { Actor } from "../src/attribution/index.js";
import * as attribution from "../src/attribution/index.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined;
let openDb: { close(): void } | undefined;
afterEach(() => {
  openDb?.close();
  openDb = undefined;
  env?.cleanup();
});

const supActor: Actor = { agent: "supervisor:j1", role: "supervisor", model: "paid:anthropic/x", job: "j1" };
const workActor: Actor = { agent: "inspector:t1", role: "inspector", model: "groq/m", task: "t1", job: "j1" };

function setup(extra: Record<string, unknown> = {}) {
  env = makeEnv(extra.config ? { config: extra.config as Record<string, unknown> } : {});
  const db = openDatabase(env.cfg.storageDir);
  openDb = db;
  const brain = new Brain(env.cfg, db);
  const access = new BrainAccess(db, env.cfg);
  const ctx = { project: "demo", effort: "job-j1", repos: ["core"], jobId: "j1", tier: "T2" as const };
  const supervisor = access.principalFor("supervisor", { ...ctx, task: null });
  const worker = (): Principal => access.principalFor("inspector", { ...ctx, task: "t1" });
  return { db, brain, access, supervisor, worker };
}

const goodLedger = {
  title: "Inspect add()",
  agent: "supervisor",
  changed: "nothing",
  why: "find the bug",
  validation: "`npx vitest run` -> 3 passed",
  outcome: "Accepted" as const,
  followUp: "none",
};

describe("brain: working documents in git", () => {
  it("serializes shared-project initialization with writes and never commits its lock", async () => {
    const { brain, db } = setup();
    mkdirSync(brain.root, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: brain.root });
    const other = new Brain({ ...env!.cfg, brain: { ...env!.cfg.brain, project: "storefront" } }, db);
    const commit = attribution.commitAs;
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(attribution, "commitAs").mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await commit(...args);
      } finally { active--; }
    });
    try {
      const writes = await Promise.allSettled([
        brain.write({ kind: "human" }, supActor, "projects/demo/facts/one.md", "# One"),
        other.write({ kind: "human" }, supActor, "projects/storefront/facts/two.md", "# Two"),
      ]);
      expect(writes.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(peak).toBe(1);
      expect(execFileSync("git", ["ls-files", "--", ".switchyard-brain.lock"], { cwd: brain.root, encoding: "utf8" }).trim()).toBe("");
      expect((await brain.history("projects/demo/facts/one.md"))[0]?.agent).toBe(supActor.agent);
      expect((await other.history("projects/storefront/facts/two.md"))[0]?.agent).toBe(supActor.agent);
    } finally { spy.mockRestore(); }
  });

  it("creates a protocol working doc committed under the supervisor's identity", async () => {
    const { brain, supervisor } = setup();
    const { path: p, commit } = await brain.createWorkingDoc(supervisor, supActor, "job-j1", { title: "Fix add", statusDetail: "started", owner: "supervisor", scope: "fix add()", currentState: "Nothing done yet." });
    expect(p).toBe("projects/demo/working/job-j1.md");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const text = readFileSync(path.join(brain.root, p), "utf8");
    expect(text).toMatch(/^# Fix add\n\nStatus: Active\n/);
    const bl = await brain.blame(p);
    expect(bl[0]!.agent).toBe("supervisor:j1");
    expect(bl[0]!.model).toBe("paid:anthropic/x");
    // The project's own index lists the document; the root index names projects, not their documents.
    expect(readFileSync(path.join(brain.root, "projects/demo/README.md"), "utf8")).toContain("projects/demo/working/job-j1.md");
    expect(readFileSync(path.join(brain.root, "README.md"), "utf8")).not.toContain("job-j1.md");
  });

  it("workers read what their brief grants and write only their own report", async () => {
    const { brain, supervisor, worker } = setup();
    await brain.createWorkingDoc(supervisor, supActor, "job-j1", { title: "T", statusDetail: "s", owner: "o", scope: "s", currentState: "state" });
    const w = worker();
    expect(brain.read(w, "projects/demo/working/job-j1.md", { section: "Current State" }).content).toBe("state");
    await expect(brain.setCurrentState(w, workActor, "projects/demo/working/job-j1.md", "hijack")).rejects.toThrow(/no write access/);
    await expect(brain.write(w, workActor, "projects/demo/working/job-j1/reports/t2.md", "x")).rejects.toThrow(/no write access/);
    await expect(brain.writeReport(w, workActor, "projects/demo/working/job-j1/reports/t1.md", "# Report: t1\nfree text")).rejects.toThrow(/report rejected/);
    const r = await brain.writeReport(w, workActor, "projects/demo/working/job-j1/reports/t1.md", { label: "t1", outcome: "Done", outcomeContext: "found it", changed: "nothing", commands: "`git grep add` -> 2 hits", notVerified: "runtime", questions: "none" });
    expect(r.commit).toBeTruthy();
    expect(() => brain.read(w, "global/glossary.md")).not.toThrow();
    expect(() => brain.read(w, "projects/other/working/x.md")).toThrow(/no read access/);
  });

  it("the ledger is append-only and needs real validation", async () => {
    const { brain, supervisor } = setup();
    const doc = "projects/demo/working/job-j1.md";
    await brain.createWorkingDoc(supervisor, supActor, "job-j1", { title: "T", statusDetail: "s", owner: "o", scope: "s", currentState: "state" });
    await expect(brain.appendLedger(supervisor, supActor, doc, { ...goodLedger, validation: "worker reported success" })).rejects.toThrow(/not what an agent reported/);
    await brain.appendLedger(supervisor, supActor, doc, goodLedger);
    const text = readFileSync(path.join(brain.root, doc), "utf8");
    expect(text).toContain("- Validation: `npx vitest run` -> 3 passed");
    const tampered = text.replace("find the bug", "rewritten history");
    await expect(brain.write(supervisor, supActor, doc, tampered)).rejects.toThrow(/append-only/);
    await expect(brain.setCurrentState(supervisor, supActor, doc, Array.from({ length: 151 }, (_, i) => `line ${i}`).join("\n"))).rejects.toThrow(/limit is 150/);
    await brain.setCurrentState(supervisor, supActor, doc, "**Done:** found the bug.");
    expect(brain.read(supervisor, doc, { section: "Current State" }).content).toBe("**Done:** found the bug.");
    expect(brain.read(supervisor, doc, { section: "Work Ledger" }).content).toContain("Inspect add()");
  });

  it("access requests: pending until the approver decides, then granted", async () => {
    const { brain, access, supervisor, worker } = setup();
    mkdirSync(path.join(brain.root, "projects/demo/facts"), { recursive: true });
    await brain.write(supervisor, supActor, "projects/demo/facts/build.md", "# Build\n\nUse pnpm.\n");
    const w = worker();
    expect(() => brain.read(w, "projects/demo/facts/build.md")).toThrow(/brain_request_access/);
    const req = access.request(w, "projects/demo/facts/**", "read", "need build facts");
    expect(req.status).toBe("pending");
    access.decide(req.id, true, "supervisor:j1", "relevant to the task");
    expect(brain.read(worker(), "projects/demo/facts/build.md").content).toContain("Use pnpm");
  });

  it("auto-approve rules grant matching requests immediately", async () => {
    const cfg = baseConfig({ brain: { path: "brain", project: "demo", auto_approve: [{ pattern: "projects/demo/facts/**", mode: "read", min_tier: "T2" }] } });
    const { access, worker } = setup({ config: cfg });
    expect(access.request(worker(), "projects/demo/facts/**", "read", "x").status).toBe("approved");
    expect(access.request(worker(), "projects/demo/facts/**", "write", "x").status).toBe("pending");
  });

  it("search is indexed from the files and filtered by access", async () => {
    const { brain, supervisor, worker } = setup();
    await brain.createWorkingDoc(supervisor, supActor, "job-j1", { title: "Cart bug", statusDetail: "s", owner: "o", scope: "s", currentState: "The discount is applied twice in finalize." });
    mkdirSync(path.join(brain.root, "projects/demo/facts"), { recursive: true });
    await brain.write(supervisor, supActor, "projects/demo/facts/secret.md", "# Secret\n\ndiscount codes live in vault\n");
    expect(brain.search(supervisor, "discount").map((r) => r.path).sort()).toEqual(["projects/demo/facts/secret.md", "projects/demo/working/job-j1.md"]);
    expect(brain.search(worker(), "discount").map((r) => r.path)).toEqual(["projects/demo/working/job-j1.md"]);
  });

  it("edits made outside SwitchYard are committed as the user before SwitchYard writes", async () => {
    const { brain, supervisor } = setup();
    await brain.createWorkingDoc(supervisor, supActor, "job-j1", { title: "T", statusDetail: "s", owner: "o", scope: "s", currentState: "state" });
    writeFileSync(path.join(brain.root, "global/glossary.md"), "# Glossary\n\nhand-written term\n");
    await brain.appendLedger(supervisor, supActor, "projects/demo/working/job-j1.md", goodLedger);
    const log = execFileSync("git", ["log", "--format=%(trailers:key=Agent,valueonly)%x09%s", "-3"], { cwd: brain.root }).toString();
    expect(log).toMatch(/human\s*\tRecord edits made outside SwitchYard/);
  });

  it("mounts map a prefix to an existing folder and do not commit by default", async () => {
    const tmp = makeEnv();
    const docs = path.join(tmp.dir, "docs-working");
    mkdirSync(docs);
    const cfg = parseConfig(baseConfig({ brain: { path: "brain", project: "demo", mounts: [{ prefix: "projects/demo/working", path: docs }] } }), tmp.cfg.configPath);
    const db = openDatabase(tmp.cfg.storageDir);
    const brain = new Brain(cfg, db);
    const sup = new BrainAccess(db, cfg).principalFor("supervisor", { project: "demo", effort: "e", repos: [], task: null, jobId: null, tier: null });
    const r = await brain.createWorkingDoc(sup, supActor, "mounted", { title: "M", statusDetail: "s", owner: "o", scope: "s", currentState: "x" });
    expect(existsSync(path.join(docs, "mounted.md"))).toBe(true);
    expect(r.commit).toBeNull();
    db.close();
    tmp.cleanup();
  });
});
