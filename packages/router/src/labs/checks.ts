import { z } from "zod";
import { newId } from "../storage/db.js";
import { SwitchyardError } from "../core/errors.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { runProcess } from "../runners/coding/process.js";
import type { LabRecord } from "./store.js";
import { LabsStore } from "./store.js";
import { labEnvironment, labValues } from "./environment.js";
import { LabNameSchema, substitute } from "./recipe.js";
export const LabCheckResultSchema = z.object({ id: z.string(), name: z.string(), repository: z.string(), revision: z.string().regex(/^[a-f0-9]{40,64}$/), exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), killed: z.string().nullable(), durationMs: z.number(), createdAt: z.number() });
export type LabCheckResult = z.infer<typeof LabCheckResultSchema>;
export async function runLabCheck(store: LabsStore, lab: LabRecord, name: string, timeoutSeconds: number, signal?: AbortSignal): Promise<LabCheckResult> {
  LabNameSchema.parse(name);
  const check = lab.recipe.checks[name];
  if (!Object.hasOwn(lab.recipe.checks, name) || !check)
    throw new SwitchyardError("not_found", `unknown declared lab check ${name}`);
  const alias = typeof check === "string" ? lab.repositories[0]?.alias : check.repo ?? lab.repositories[0]?.alias;
  const repo = lab.repositories.find(r => r.alias === alias);
  if (!repo)
    throw new Error("lab check repository is unavailable");
  if ((await dirtyPaths(repo.worktree)).length)
    throw new SwitchyardError("lab_dirty", "commit lab changes before running revision-bound checks");
  const revision = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
  const result = await runProcess(substitute(typeof check === "string" ? check : check.command, labValues(lab)), [], { cwd: repo.worktree, env: labEnvironment(lab), timeoutMs: timeoutSeconds * 1000, shell: true, signal });
  const record = LabCheckResultSchema.parse({ id: newId("lc"), name, repository: repo.alias, revision, ...result, createdAt: Date.now() });
  // The check cannot certify edits that occurred concurrently with its command.
  if ((await git(repo.worktree, ["rev-parse", "HEAD"])).trim() !== revision || (await dirtyPaths(repo.worktree)).length) {
    record.exitCode = 1;
    record.killed = "revision_changed";
    record.stderr += "\nLab revision changed during the check";
  }
  store.db.prepare("INSERT INTO lab_checks(id,lab_id,name,repository,revision,result_json,created_at) VALUES(?,?,?,?,?,?,?)").run(record.id, lab.id, name, repo.alias, revision, JSON.stringify(record), record.createdAt);
  store.event(lab.id, "check_finished", { id: record.id, name, revision, exitCode: record.exitCode, killed: record.killed });
  return record;
}
export function labChecks(store: LabsStore, labId: string): LabCheckResult[] {
  return (store.db.prepare("SELECT result_json FROM lab_checks WHERE lab_id=? ORDER BY created_at DESC LIMIT 100").all(labId) as Array<{
    result_json: string;
  }>).map(r => LabCheckResultSchema.parse(JSON.parse(r.result_json)));
}
