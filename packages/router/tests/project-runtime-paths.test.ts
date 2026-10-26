import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeIdentity, ProjectRuntimeManifestSchema, projectRuntimePaths, runtimeWorkspacePath, validateRuntimeLocation } from "../src/projects/runtime-paths.js";

const temporary: string[] = [];
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meritrouter-path-contract-"));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("project runtime path contract", () => {
  it("constructs project-local readable paths without creating directories", async () => {
    const root = await project();
    const job = createRuntimeIdentity("job_1", "Facebook MVP");
    const subject = createRuntimeIdentity("task_1", "Profile page");
    const target = runtimeWorkspacePath(root, { job, subject, kind: "task", attempt: 2, repository: "app" });
    expect(target).toContain(path.join(".MeritRouter", "jobs", job.directoryName, "tasks", subject.directoryName, "attempts", "02", "repositories", createRuntimeIdentity("app", "app").directoryName));
    await expect(validateRuntimeLocation(root, target)).resolves.toBeUndefined();
    await expect(import("node:fs/promises").then(fs => fs.stat(projectRuntimePaths(root).root))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains original persisted identity despite later display-name changes", () => {
    const identity = createRuntimeIdentity("job_1", "Original title");
    const restored = ProjectRuntimeManifestSchema.parse(JSON.parse(JSON.stringify({ layoutVersion: 1, projectId: "project_1", jobs: [identity] })));
    expect(restored.jobs[0]).toEqual(identity);
    expect(createRuntimeIdentity("job_1", "New title").directoryName).not.toBe(identity.directoryName);
    expect(createRuntimeIdentity("job_A", "Same label").directoryName).not.toBe(createRuntimeIdentity("job_a", "Same label").directoryName);
  });
  it.each(["../escape", "CON", "aux.txt", "COM1", "trailing.", "trailing ", "branch/main", "a\\b", "a:b", "a\0b"])("rejects unsafe label %s", value => {
    expect(() => createRuntimeIdentity("id", value)).toThrow();
  });
  it("rejects tampered manifests, duplicate IDs and unknown layout versions", () => {
    const job = createRuntimeIdentity("job", "A job");
    expect(() => ProjectRuntimeManifestSchema.parse({ layoutVersion: 2, projectId: "p", jobs: [] })).toThrow();
    expect(() => ProjectRuntimeManifestSchema.parse({ layoutVersion: 1, projectId: "p", jobs: [job, job] })).toThrow();
    expect(() => runtimeWorkspacePath(os.tmpdir(), { job: { ...job, directoryName: "elsewhere" }, subject: job, kind: "version", repository: "app" })).toThrow();
  });
  it("requires task attempts and forbids version attempts and unsafe repo aliases", () => {
    const job = createRuntimeIdentity("job", "A job");
    expect(() => runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "task", repository: "app" })).toThrow();
    expect(() => runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", attempt: 1, repository: "app" })).toThrow();
    expect(() => runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", repository: ".." })).toThrow();
    expect(runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", repository: "app" })).toContain(path.join("versions", job.directoryName, "repositories", createRuntimeIdentity("app", "app").directoryName));
  });
  it("keeps case-distinct repository aliases distinct on case-insensitive filesystems", () => {
    const job = createRuntimeIdentity("job", "A job");
    const lower = runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", repository: "app" });
    const upper = runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", repository: "APP" });
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });
  it.each(["_lib", "-lib", ".repo"])("supports existing portable repository alias %s", repository => {
    const job = createRuntimeIdentity("job", "A job");
    expect(() => runtimeWorkspacePath(os.tmpdir(), { job, subject: job, kind: "version", repository })).not.toThrow();
  });
  it.skipIf(process.platform !== "win32")("rejects Windows root-relative paths without a drive", () => {
    expect(() => projectRuntimePaths("\\project")).toThrow("drive-qualified");
    expect(() => projectRuntimePaths("/project")).toThrow("drive-qualified");
    expect(() => projectRuntimePaths("C:\\project")).not.toThrow();
    expect(() => projectRuntimePaths("\\\\server\\share\\project")).not.toThrow();
  });
  it.skipIf(process.platform !== "win32").each(["//?/C:/project", "//./C:/project", "\\\\?\\C:/project", "/\\.\\C:/project"])("rejects normalized Windows namespace %s", value => {
    expect(() => projectRuntimePaths(value)).toThrow();
  });
  it("rejects relative/root project directories and sibling escapes", async () => {
    expect(() => projectRuntimePaths("relative")).toThrow();
    expect(() => projectRuntimePaths(path.parse(os.tmpdir()).root)).toThrow();
    const root = await project();
    await expect(validateRuntimeLocation(root, path.join(root, ".MeritRouter-other", "file"))).rejects.toThrow("escapes");
  });
  it.each(["trailing.", "trailing ", "CON", "aux.txt", "data:stream"])("rejects ambiguous project and candidate components %s", async component => {
    const root = await project();
    expect(() => projectRuntimePaths(path.join(root, component))).toThrow("Windows-ambiguous");
    await expect(validateRuntimeLocation(root, path.join(projectRuntimePaths(root).root, component))).rejects.toThrow("Windows-ambiguous");
  });
  it("rejects legacy casing and file ancestors", async () => {
    const root = await project();
    await mkdir(path.join(root, ".meritrouter"));
    await expect(validateRuntimeLocation(root, projectRuntimePaths(root).root)).rejects.toThrow("migration");
    const other = await project();
    await writeFile(projectRuntimePaths(other).root, "file");
    await expect(validateRuntimeLocation(other, projectRuntimePaths(other).root)).rejects.toThrow("not a directory");
    await expect(validateRuntimeLocation(other, path.join(projectRuntimePaths(other).root, "state"))).rejects.toThrow("not a directory");
  });
  it("rejects an existing junction/symlink escaping project ownership", async () => {
    const root = await project();
    const outside = await project();
    await symlink(outside, projectRuntimePaths(root).root, process.platform === "win32" ? "junction" : "dir");
    await expect(validateRuntimeLocation(root, path.join(projectRuntimePaths(root).root, "state"))).rejects.toThrow("Symbolic links/junctions");
  });
});
