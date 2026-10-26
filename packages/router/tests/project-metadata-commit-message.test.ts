import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCommitMessage } from "../src/attribution/commit-message.js";
import { actorIdentity, parseTrailers, trailerArgs } from "../src/attribution/index.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { prepareGitProcess } from "../src/workspaces/git-process-policy.js";
import { git } from "../src/workspaces/git.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const actor = { agent: "worker:message", role: "implementer", model: "fake/model", task: "task\r\ncontinued" };
const identity = actorIdentity(actor);
const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
async function repo(config: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meritrouter-message-")); roots.push(root);
  await git(root, ["init", "-q", "-b", "main"]);
  for (const [key, value] of Object.entries(config)) await git(root, ["config", key, value]);
  return root;
}
function native(root: string, args: string[]): Buffer {
  const policy = prepareGitProcess(root, args, env);
  return execFileSync("git", policy.args, { cwd: root, env: policy.env, windowsHide: true, timeout: 10000 });
}
function payload(object: Buffer) { return object.subarray(object.indexOf(Buffer.from("\n\n")) + 2); }

describe("native non-editor commit message preparation", () => {
  const matrix: Array<{ name: string; message: string; config?: Record<string, string>; extra?: Record<string, string> }> = [
    { name: "ordinary", message: "Subject" },
    { name: "blank and trailing whitespace", message: "\n\n Subject  \t\n\n\nBody\t \n\n" },
    { name: "comments by default", message: "Subject\n\n# preserved commentary\nbody" },
    { name: "CRLF Unicode", message: "Résumé 🚦\r\n\r\nbody\r\n\t\r\n" },
    { name: "existing trailers", message: "Subject\n\nAgent: previous\nRole: implementer\n" },
    { name: "duplicate and extra Actor keys", message: "Subject\n\nAgent: replacement\n", extra: { Agent: "replacement", Worker: "first\nsecond" } },
    { name: "patch divider retained", message: "Subject\n\n---\nbody\n\nAgent: old" },
    { name: "explicit default", message: "\nSubject  \n# comment\n\n", config: { "commit.cleanup": "default" } },
    { name: "whitespace", message: "\nSubject  \n# comment\n\n", config: { "commit.cleanup": "whitespace" } },
    { name: "strip", message: "\nSubject  \n# comment\n\n", config: { "commit.cleanup": "strip" } },
    { name: "custom comment", message: "Subject\n; remove\n# preserve\n", config: { "commit.cleanup": "strip", "core.commentChar": ";" } },
    { name: "custom comment string", message: "Subject\n// remove\n# preserve\n", config: { "commit.cleanup": "strip", "core.commentString": "//" } },
    { name: "verbatim", message: "\nSubject  \n\n\nBody\t \n\n", config: { "commit.cleanup": "verbatim" } },
    { name: "scissors without editor", message: "Subject\n\n# ------------------------ >8 ------------------------\nkept\n", config: { "commit.cleanup": "scissors" } },
    { name: "explicit UTF8", message: "Ünicode 🚦", config: { "i18n.commitEncoding": "UTF-8", "commit.verbose": "false" } },
    { name: "separator", message: "Subject\n\nAgent% old\n", config: { "trailer.separators": "%=$" } },
    { name: "where start", message: "Subject\n\nAgent: previous\n", config: { "trailer.where": "start" } },
    { name: "where before", message: "Subject\n\nAgent: previous\n", config: { "trailer.where": "before" } },
    { name: "where after", message: "Subject\n\nAgent: previous\n", config: { "trailer.where": "after" } },
    { name: "replace existing", message: "Subject\n\nAgent: previous\n", config: { "trailer.ifExists": "replace" } },
    { name: "keep existing", message: "Subject\n\nAgent: previous\n", config: { "trailer.ifExists": "doNothing" } },
    { name: "always add existing", message: "Subject\n\nAgent: worker:message\n", config: { "trailer.ifExists": "add" } },
    { name: "add different existing", message: "Subject\n\nAgent: worker:message\n", config: { "trailer.ifExists": "addIfDifferent" } },
    { name: "do not add missing", message: "Subject\n\nAgent: previous\n", config: { "trailer.ifMissing": "doNothing" } },
    { name: "configured key alias", message: "Subject\n\nSigned-off-by: old\n", config: { "trailer.Agent.key": "Signed-off-by: ", "trailer.Agent.ifExists": "add" } },
    { name: "empty subject with Actor trailers", message: "" },
  ];
  it.each(matrix)("matches exact native message bytes: $name", async ({ message, config, extra }) => {
    const root = await repo(config);
    const args = trailerArgs(actor, extra), trailers = args.filter((_, offset) => offset % 2 === 1);
    const prepared = await prepareCommitMessage(root, { message, trailers });
    expect(await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [1] })).toBe("");
    native(root, ["commit", "-q", "--allow-empty", "-m", message, ...args]);
    const object = native(root, ["cat-file", "commit", "HEAD"]);
    expect(Buffer.from(prepared, "utf8")).toEqual(payload(object));
    expect(object.toString("utf8")).toContain(`author ${identity.name} <${identity.email}>`);
    expect(object.toString("utf8")).toContain(`committer ${identity.name} <${identity.email}>`);
    expect(parseTrailers(prepared)).toEqual(parseTrailers(payload(object).toString("utf8")));
  });

  it.each([
    { key: "commit.cleanup", value: "unknown", reason: "commit.cleanup" },
    { key: "commit.cleanup", value: "", reason: "commit.cleanup" },
    { key: "i18n.commitEncoding", value: "ISO-8859-1", reason: "UTF-8" },
    { key: "commit.verbose", value: "true", reason: "commit.verbose" },
    { key: "commit.verbose", value: "", reason: "commit.verbose" },
    { key: "core.commentChar", value: "auto", reason: "commentChar" },
  ])("refuses unsupported $key before staging or publication", async ({ key, value, reason }) => {
    const root = await repo(); await writeFile(path.join(root, "app.txt"), "one");
    await git(root, ["add", "app.txt"]); native(root, ["commit", "-q", "-m", "initial"]);
    const before = await readFile(path.join(root, ".git", "index")), head = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["config", key, value]); await writeFile(path.join(root, "app.txt"), "two");
    await expect(commitSelectedApplication(root, { actor, message: "new" })).rejects.toThrow(reason);
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(before);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("keeps stdin authority exact, bounded and non-file-writing", async () => {
    const root = await repo();
    for (const args of [["stripspace", "--comment-lines"], ["interpret-trailers", "--in-place", "foreign"], ["interpret-trailers", "--no-divider", "--trailer", "Agent: one\ntwo"], ["config", "--list"]]) {
      await expect(git(root, args, { input: "subject" })).rejects.toThrow(/stdin/);
    }
    await expect(git(root, ["stripspace"], { input: "x".repeat(65537) })).rejects.toThrow(/stdin/);
    await expect(git(root, ["stripspace"])).rejects.toThrow(/stdin/);
    await expect(git(root, ["interpret-trailers", "--in-place", "foreign"])).rejects.toThrow(/stdin/);
    expect(() => prepareGitProcess(root, ["interpret-trailers", "--in-place", "foreign"])).toThrow(/formatting-only/);
    await expect(git(root, ["stripspace"], { input: "subject", env: { GIT_INDEX_FILE: "foreign" } })).rejects.toThrow(/override denied/);
    await expect(prepareCommitMessage(root, { message: "\0", trailers: [] })).rejects.toThrow();
  });

  it("denies executable trailer config instead of invoking it", async () => {
    const root = await repo(); await git(root, ["config", "trailer.Agent.cmd", "echo forbidden"]);
    await expect(prepareCommitMessage(root, { message: "subject", trailers: ["Agent: fixture"] })).rejects.toThrow(/unsafe repository Git configuration/);
  });

  it.each(["verbose", "cleanup"])("refuses valueless commit.%s instead of treating it as unset", async key => {
    const root = await repo(), config = path.join(root, ".git", "config");
    await writeFile(config, `${await readFile(config, "utf8")}\n[commit]\n\t${key}\n`);
    await expect(prepareCommitMessage(root, { message: "subject", trailers: ["Agent: fixture"] })).rejects.toThrow(`commit.${key}`);
  });

  it("does not hide invalid earlier verbose config behind a later false value", async () => {
    const root = await repo({ "commit.verbose": "invalid" }); await git(root, ["config", "--add", "commit.verbose", "false"]);
    await expect(prepareCommitMessage(root, { message: "subject", trailers: ["Agent: fixture"] })).rejects.toThrow("commit.verbose");
  });
});
