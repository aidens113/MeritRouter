import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const PROJECT_RUNTIME_DIRECTORY = ".MeritRouter";
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

function directoryName(id: string, displayLabel: string): string {
  const readable = displayLabel.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "item";
  return `${readable}--${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** Persist this identity once. Renaming a display label must not regenerate its directory. */
export const RuntimeIdentitySchema = z.object({
  id: stableId,
  initialLabel: label,
  directoryName: safeComponent,
}).strict().refine(value => value.directoryName === directoryName(value.id, value.initialLabel),
  "Directory identity does not match its original label and stable ID");
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

export function createRuntimeIdentity(id: string, initialLabel: string): RuntimeIdentity {
  const input = z.object({ id: stableId, initialLabel: label }).strict().parse({ id, initialLabel });
  return RuntimeIdentitySchema.parse({ ...input, directoryName: directoryName(input.id, input.initialLabel) });
}

/** Store under project.json; future layout versions require explicit migration. */
export const ProjectRuntimeManifestSchema = z.object({
  layoutVersion: z.literal(1),
  projectId: stableId,
  jobs: z.array(RuntimeIdentitySchema).max(10000),
}).strict().refine(value => new Set(value.jobs.map(job => job.id)).size === value.jobs.length,
  "Duplicate job identity");

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
  job: RuntimeIdentitySchema,
  subject: RuntimeIdentitySchema,
  kind: z.enum(["task", "version"]),
  attempt: z.number().int().min(1).max(999999).optional(),
  repository: repositoryAlias,
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "task") !== (value.attempt !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only task workspaces require an attempt" });
  }
});
export type RuntimeWorkspaceInput = z.infer<typeof workspaceInput>;

/** Consumers load persisted identities; current display names are deliberately not inputs. */
export function runtimeWorkspacePath(projectDirectory: string, input: RuntimeWorkspaceInput): string {
  const parsed = workspaceInput.parse(input);
  const roots = projectRuntimePaths(projectDirectory);
  const base = path.join(roots.jobs, parsed.job.directoryName,
    parsed.kind === "task" ? "tasks" : "versions", parsed.subject.directoryName);
  const repositoryDirectory = directoryName(parsed.repository, parsed.repository);
  const result = parsed.kind === "task"
    ? path.join(base, "attempts", String(parsed.attempt).padStart(2, "0"), "repositories", repositoryDirectory)
    : path.join(base, "repositories", repositoryDirectory);
  if (result.length > 1024) throw new Error("Runtime workspace path exceeds the supported 1024-character bound");
  return result;
}

/**
 * Read-only preflight, not race-free filesystem authorization. Requires an existing project
 * directory; rejects existing symbolic links/junctions throughout the path (even inward links).
 * Callers must revalidate at mutation time and use ownership receipts for cleanup/migration.
 */
export async function validateRuntimeLocation(projectDirectory: string, candidate: string): Promise<void> {
  const roots = projectRuntimePaths(projectDirectory);
  validateAbsoluteDirectory(candidate);
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
