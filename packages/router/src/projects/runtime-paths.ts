import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const PROJECT_RUNTIME_DIRECTORY = ".MeritRouter";
/** Conservative native-process cwd bound; Git deep-filename support is a separate concern. */
export const MAX_WINDOWS_RUNTIME_CWD = 240;
const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const safeComponent = z.string().min(1).max(80).refine(
  value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && !/[. ]$/.test(value) && !reserved.test(value),
  "Expected a portable, non-reserved directory component",
);
const stableId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const repositoryAlias = z.string().min(1).max(80).refine(value =>
  /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== ".."
    && !/[. ]$/.test(value) && !reserved.test(value), "Expected a portable repository alias");
const label = z.string().min(1).max(80).refine(value =>
  value.trim() === value && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value)
    && !/[. ]$/.test(value) && !reserved.test(value) && value !== "." && value !== "..",
"Expected a portable human-readable label (use a branch display label, not a slash-delimited ref)");

function directoryName(id: string, displayLabel: string, layoutVersion: 1 | 2 = 1, readableLimit = 16): string {
  const readable = displayLabel.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "item";
  const digest = createHash("sha256").update(id).digest().subarray(0, 16);
  if (layoutVersion === 1) return `${readable}--${digest.toString("hex")}`;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let number = BigInt(`0x${digest.toString("hex")}`), encoded = "";
  for (let i = 0; i < 26; i++) { encoded = alphabet[Number(number & 31n)]! + encoded; number >>= 5n; }
  return `${readable.slice(0, readableLimit)}--${encoded}`;
}

/** Persist this identity once. Renaming a display label must not regenerate its directory. */
const RuntimeIdentityV1Schema = z.object({
  id: stableId,
  initialLabel: label,
  directoryName: safeComponent,
}).strict().refine(value => value.directoryName === directoryName(value.id, value.initialLabel),
  "Directory identity does not match its original label and stable ID");
const RuntimeIdentityV2Schema = z.object({
  layoutVersion: z.literal(2), id: stableId, initialLabel: label, directoryName: safeComponent,
}).strict().refine(value => value.directoryName === directoryName(value.id, value.initialLabel, 2),
  "Compact directory identity does not match its original label and stable ID");
export const RuntimeIdentitySchema = z.union([RuntimeIdentityV1Schema, RuntimeIdentityV2Schema]);
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export function createRuntimeIdentity(id: string, initialLabel: string, layoutVersion: 1 | 2 = 1): RuntimeIdentity {
  const input = z.object({ id: stableId, initialLabel: label }).strict().parse({ id, initialLabel });
  z.union([z.literal(1), z.literal(2)]).parse(layoutVersion);
  return RuntimeIdentitySchema.parse({ ...input, ...(layoutVersion === 2 ? { layoutVersion } : {}), directoryName: directoryName(input.id, input.initialLabel, layoutVersion) });
}

export const createCompactRuntimeIdentity = (id: string, initialLabel: string): RuntimeIdentity => createRuntimeIdentity(id, initialLabel, 2);
export const CompactRepositoryIdentitySchema = z.object({ alias: repositoryAlias, directoryName: safeComponent }).strict()
  .refine(value => value.directoryName === directoryName(value.alias, value.alias, 2, 12), "Repository directory identity mismatch");
export function createCompactRepositoryIdentity(alias: string): z.infer<typeof CompactRepositoryIdentitySchema> {
  repositoryAlias.parse(alias);
  return CompactRepositoryIdentitySchema.parse({ alias, directoryName: directoryName(alias, alias, 2, 12) });
}

/** Store under project.json; future layout versions require explicit migration. */
const manifestV1 = z.object({
  layoutVersion: z.literal(1),
  projectId: stableId,
  jobs: z.array(RuntimeIdentityV1Schema).max(10000),
}).strict().refine(value => new Set(value.jobs.map(job => job.id)).size === value.jobs.length,
  "Duplicate job identity");
const manifestV2 = z.object({
  layoutVersion: z.literal(2), projectId: stableId,
  jobs: z.array(RuntimeIdentityV2Schema).max(10000),
  repositories: z.array(CompactRepositoryIdentitySchema).max(1000).default([]),
}).strict().superRefine((value, ctx) => {
  for (const [name, entries] of [["jobs", value.jobs.map(job => ({ id: job.id, dir: job.directoryName }))],
    ["repositories", value.repositories.map(repo => ({ id: repo.alias, dir: repo.directoryName }))]] as const) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length
      || new Set(entries.map(entry => entry.dir.toLowerCase())).size !== entries.length) {
      ctx.addIssue({ code: "custom", path: [name], message: "Duplicate identity or directory collision" });
    }
  }
});
export const ProjectRuntimeManifestSchema = z.union([manifestV1, manifestV2]);

export interface ProjectRuntimePaths {
  projectDirectory: string;
  root: string;
  manifest: string;
  state: string;
  brain: string;
  sessions: string;
  artifacts: string;
  jobs: string;
}

function validateAbsoluteDirectory(value: string): void {
  z.string().min(1).max(4096).refine(input => path.isAbsolute(input) && !input.includes("\0"),
    "Expected an explicit absolute directory").parse(value);
  const windowsValue = value.replace(/\//g, "\\");
  if (process.platform === "win32" && !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/.test(windowsValue)) {
    throw new Error("Expected a drive-qualified or UNC absolute directory");
  }
  const root = path.parse(value).root;
  const components = value.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : /\//).filter(Boolean);
  if (components.some(component => component === "." || component === ".."
    || /[\x00-\x1f\x7f<>:"\\|?*]/.test(component)
    || /[. ]$/.test(component) || reserved.test(component))) {
    throw new Error("Directory contains traversal or a Windows-ambiguous component");
  }
  // Device/extended-length namespaces introduce a different parsing/authorization contract.
  if (process.platform === "win32" && /^\\\\[?.]\\/.test(windowsValue)) {
    throw new Error("Windows device/extended-length directory syntax is unsupported");
  }
}

/** Pure path construction, not an authorization check. Uses the host filesystem dialect. */
export function projectRuntimePaths(projectDirectory: string): ProjectRuntimePaths {
  validateAbsoluteDirectory(projectDirectory);
  const project = path.normalize(projectDirectory);
  if (project === path.parse(project).root) throw new Error("A filesystem root cannot own a project runtime");
  const root = path.join(project, PROJECT_RUNTIME_DIRECTORY);
  return {
    projectDirectory: project, root, manifest: path.join(root, "project.json"),
    state: path.join(root, "state"), brain: path.join(root, "brain"),
    sessions: path.join(root, "sessions"), artifacts: path.join(root, "artifacts"), jobs: path.join(root, "jobs"),
  };
}

const workspaceInput = z.object({
  layoutVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  job: RuntimeIdentitySchema,
  subject: RuntimeIdentitySchema,
  kind: z.enum(["task", "version"]),
  attempt: z.number().int().min(1).max(999999).optional(),
  repository: repositoryAlias,
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "task") !== (value.attempt !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only task workspaces require an attempt" });
  }
  const version = (identity: RuntimeIdentity) => "layoutVersion" in identity ? identity.layoutVersion : 1;
  if (version(value.job) !== version(value.subject) || (value.layoutVersion !== undefined && value.layoutVersion !== version(value.job))) {
    ctx.addIssue({ code: "custom", message: "Workspace and persisted identity layout versions must agree; explicit migration is required" });
  }
});
export type RuntimeWorkspaceInput = z.infer<typeof workspaceInput>;

/** Consumers load persisted identities; current display names are deliberately not inputs. */
export function runtimeWorkspacePath(projectDirectory: string, input: RuntimeWorkspaceInput): string {
  const parsed = workspaceInput.parse(input);
  const version = "layoutVersion" in parsed.job ? parsed.job.layoutVersion : 1;
  const roots = projectRuntimePaths(projectDirectory);
  const base = path.join(roots.jobs, parsed.job.directoryName,
    parsed.kind === "task" ? "tasks" : "versions", parsed.subject.directoryName);
  const repositoryDirectory = directoryName(parsed.repository, parsed.repository, version, 12);
  const result = version === 2
    ? path.join(base, ...(parsed.kind === "task" ? [`run-${String(parsed.attempt).padStart(2, "0")}`] : []), repositoryDirectory)
    : parsed.kind === "task"
    ? path.join(base, "attempts", String(parsed.attempt).padStart(2, "0"), "repositories", repositoryDirectory)
    : path.join(base, "repositories", repositoryDirectory);
  if (result.length > 1024) throw new Error("Runtime workspace path exceeds the supported 1024-character bound");
  if (version === 2) assertRuntimeCwdSupported(result);
  return result;
}

/** Check before mkdir/worktree creation, including when resuming a persisted legacy path. */
export function assertRuntimeCwdSupported(candidate: string): void {
  validateAbsoluteDirectory(candidate);
  if (process.platform === "win32" && path.normalize(candidate).length > MAX_WINDOWS_RUNTIME_CWD) {
    throw new Error(`Managed workspace cwd exceeds the supported Windows ${MAX_WINDOWS_RUNTIME_CWD}-character limit; choose a shorter project directory or explicitly migrate to compact layout v2`);
  }
}

/**
 * Read-only preflight, not race-free filesystem authorization. Requires an existing project
 * directory; rejects existing symbolic links/junctions throughout the path (even inward links).
 * Callers must revalidate at mutation time and use ownership receipts for cleanup/migration.
 */
export async function validateRuntimeLocation(projectDirectory: string, candidate: string): Promise<void> {
  const roots = projectRuntimePaths(projectDirectory);
  validateAbsoluteDirectory(candidate);
  assertRuntimeCwdSupported(candidate);
  const relative = path.relative(roots.root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Runtime location escapes the project metadata directory");
  }
  const target = path.normalize(candidate);
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not supported: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Runtime location is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  if (!(await lstat(roots.projectDirectory)).isDirectory()) throw new Error("Project directory must exist");
  const names = await readdir(roots.projectDirectory);
  if (names.some(name => name.toLowerCase() === PROJECT_RUNTIME_DIRECTORY.toLowerCase() && name !== PROJECT_RUNTIME_DIRECTORY)) {
    throw new Error("Legacy or ambiguously cased metadata directory requires explicit migration");
  }
}
