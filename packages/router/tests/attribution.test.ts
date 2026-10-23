import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { blame, commitAs, commitsMatching, revertCommits, undoLines, type Actor } from "../src/attribution/index.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const human: Actor = { agent: "human", role: "human" };
const a: Actor = { agent: "implementer:t_a", role: "implementer", model: "groq/model-a", task: "t_a", job: "j1" };
const b: Actor = { agent: "implementer:t_b", role: "implementer", model: "kilo/model-b", task: "t_b", job: "j1" };
const sup: Actor = { agent: "supervisor:j1", role: "supervisor", model: "paid:anthropic/x", job: "j1" };

function repo(): string {
  dir = mkdtempSync(path.join(tmpdir(), "sy-attr-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}
const file = (r: string) => path.join(r, "app.txt");
const lines = (r: string) => readFileSync(file(r), "utf8").trimEnd().split(/\r?\n/);

describe("attribution", () => {
  it("records agent and model per line, and git identity per agent", async () => {
    const r = repo();
    writeFileSync(file(r), "one\ntwo\nthree\n");
    const base = await commitAs(r, human, "base");
    writeFileSync(file(r), "one\nTWO by a\nthree\n");
    await commitAs(r, a, "a edits two");
    writeFileSync(file(r), "one\nTWO by a\nthree\nfour by b\nfive by b\n");
    await commitAs(r, b, "b appends");

    const bl = await blame(r, "app.txt");
    expect(bl.map((l) => l.agent)).toEqual(["human", "implementer:t_a", "human", "implementer:t_b", "implementer:t_b"]);
    expect(bl[1]).toMatchObject({ model: "groq/model-a", task: "t_a", role: "implementer" });
    expect(execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: r }).toString().trim()).toBe("implementer t_b (kilo/model-b) <implementer.t_b@meritrouter.local>");
    expect((await commitsMatching(r, `${base}..HEAD`, { Model: "groq/model-a" })).map((c) => c.subject)).toEqual(["a edits two"]);
  });

  it("commits only selected paths and preserves unrelated staged additions, edits and deletions", async () => {
    const r = repo();execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: r });
    writeFileSync(file(r), "selected base\n");writeFileSync(path.join(r, "outside.txt"), "outside base\n");writeFileSync(path.join(r, "outside-delete.txt"), "outside deletion base\n");await commitAs(r, human, "base");
    writeFileSync(path.join(r, "outside.txt"), "outside staged\n");writeFileSync(path.join(r, "outside-add.txt"), "outside staged addition\n");unlinkSync(path.join(r, "outside-delete.txt"));execFileSync("git", ["add", "-A", "--", "outside.txt", "outside-add.txt", "outside-delete.txt"], { cwd: r });
    const cached = () => execFileSync("git", ["diff", "--cached", "--binary", "--", "outside.txt", "outside-add.txt", "outside-delete.txt"], { cwd: r }).toString();
    const before = cached();
    expect(await commitAs(r, a, "no selected change", { paths: ["app.txt"] })).toBeNull();
    writeFileSync(file(r), "selected edit\n");const changed = await commitAs(r, a, "selected edit", { paths: ["app.txt"] });
    expect(cached()).toBe(before);expect(execFileSync("git", ["show", "--format=", "--name-only", changed!], { cwd: r }).toString().trim()).toBe("app.txt");
    writeFileSync(path.join(r, "new.txt"), "new selected\n");await commitAs(r, b, "selected add", { paths: ["new.txt"] });expect(cached()).toBe(before);
    unlinkSync(file(r));await commitAs(r, a, "selected delete", { paths: ["app.txt"] });expect(cached()).toBe(before);
    expect(execFileSync("git", ["log", "-1", "--format=%(trailers:key=Agent,valueonly)"], { cwd: r }).toString().trim()).toBe(a.agent);
    expect(execFileSync("git", ["diff", "HEAD", "--name-only"], { cwd: r }).toString()).toContain("outside.txt");
  });

  it("undoes specific lines: added lines are removed, modified lines restored", async () => {
    const r = repo();
    writeFileSync(file(r), "one\ntwo\nthree\n");
    const base = (await commitAs(r, human, "base"))!;
    writeFileSync(file(r), "one\nTWO by a\nthree\n");
    await commitAs(r, a, "a edits");
    writeFileSync(file(r), "one\nTWO by a\nthree\nfour by b\nfive by b\n");
    await commitAs(r, b, "b appends");

    const u1 = await undoLines(r, "app.txt", [[5, 5]], sup, "five is wrong", { sinceCommit: base });
    expect(u1.undone).toEqual([5]);
    expect(lines(r)).toEqual(["one", "TWO by a", "three", "four by b"]);
    const u2 = await undoLines(r, "app.txt", [[2, 2]], sup, "restore two", { sinceCommit: base });
    expect(u2.undone).toEqual([2]);
    expect(lines(r)).toEqual(["one", "two", "three", "four by b"]);
    // Lines that predate the job are never touched.
    const u3 = await undoLines(r, "app.txt", [[1, 1]], sup, "nope", { sinceCommit: base });
    expect(u3.skipped).toEqual([{ line: 1, why: "predates this job" }]);
    const bl = await blame(r, "app.txt");
    expect(bl[1]!.agent).toBe("supervisor:j1");
    expect(execFileSync("git", ["log", "-1", "--format=%(trailers:key=Reason,valueonly)"], { cwd: r }).toString().trim()).toBe("restore two");
  });

  it("undoes everything one agent or model did, keeping history", async () => {
    const r = repo();
    writeFileSync(file(r), "one\ntwo\n");
    const base = (await commitAs(r, human, "base"))!;
    writeFileSync(file(r), "one\ntwo\nby a\n");
    await commitAs(r, a, "a");
    writeFileSync(path.join(r, "other.txt"), "by b\n");
    await commitAs(r, b, "b");
    const target = await commitsMatching(r, `${base}..HEAD`, { Agent: "implementer:t_a" });
    await revertCommits(r, target.map((c) => c.commit), sup, "task a was off-goal");
    expect(lines(r)).toEqual(["one", "two"]);
    expect(readFileSync(path.join(r, "other.txt"), "utf8")).toBe("by b\n");
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: r }).toString().trim()).toBe("4");
  });
});
