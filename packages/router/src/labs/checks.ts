import type { LabManager } from "./lab.js";
import { runBrowserCheck } from "./browser-check.js";
import { BrowserCheckSchema, BrowserEvidenceSchema } from "./browser-schema.js";
import { z } from "zod";
import { newId } from "../storage/db.js";
import { SwitchyardError } from "../core/errors.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { runProcess } from "../runners/coding/process.js";
import type { LabRecord } from "./store.js";
import { LabsStore } from "./store.js";
import { labEnvironment, labValues } from "./environment.js";
import { LabNameSchema, substitute } from "./recipe.js";
import { assertLabEffect, labEffectSignal } from "./control-authority.js";
export const LabCheckResultSchema = z.object({ id: z.string(), name: z.string(), repository: z.string(), revision: z.string().regex(/^[a-f0-9]{40,64}$/), exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), killed: z.string().nullable(), durationMs: z.number(), createdAt: z.number(), browser: BrowserEvidenceSchema.optional() });
export type LabCheckResult = z.infer<typeof LabCheckResultSchema>;
/** Browser evidence covers the whole environment, including repositories other than its service. */
export function labCheckMatchesHeads(check: Pick<LabCheckResult, "repository" | "revision" | "browser">, heads: Record<string, string | null>): boolean {
  if (check.revision !== heads[check.repository]) return false;
  if (!check.browser) return true;
  const checked = check.browser.heads;
  return Object.keys(checked).length === Object.keys(heads).length
    && Object.entries(heads).every(([alias, head]) => head !== null && checked[alias] === head);
}
export async function runLabCheck(store: LabsStore, lab: LabRecord, name: string, timeoutSeconds: number, signal?: AbortSignal, manager?: LabManager): Promise<LabCheckResult> {
  assertLabEffect();
  signal = labEffectSignal(signal);
  if(lab.kind==="task_attempt")throw new SwitchyardError("lab_scope_denied","task checks require their persisted attempt lifecycle");
  LabNameSchema.parse(name);
  const check = lab.recipe.checks[name];
  if (!Object.hasOwn(lab.recipe.checks, name) || !check)
    throw new SwitchyardError("not_found", `unknown declared lab check ${name}`);
  const alias = typeof check === "string" ? lab.repositories[0]?.alias : check.repo ?? ("kind" in check ? lab.recipe.services[check.service]?.repo : undefined) ?? lab.repositories[0]?.alias;
  const repo = lab.repositories.find(r => r.alias === alias);
  if (!repo)
    throw new Error("lab check repository is unavailable");
  if ((await dirtyPaths(repo.worktree)).length)
    throw new SwitchyardError("lab_dirty", "commit lab changes before running revision-bound checks");
  const revision = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
  const id = newId("lc");
  const command=typeof check==="string"?check:"command" in check?check.command:null;
  if(command===null&&!manager)throw new SwitchyardError("lab_invalid_state","browser check requires its scoped lab manager");
  const browser=command===null?BrowserCheckSchema.parse(check):null;
  assertLabEffect();
  const result=browser
    ?await runBrowserCheck(manager!,lab,id,{...browser,timeout_seconds:Math.min(browser.timeout_seconds,timeoutSeconds)},signal)
    :await runProcess(substitute(command!,labValues(lab)),[],{cwd:repo.worktree,env:labEnvironment(lab),timeoutMs:timeoutSeconds*1000,shell:true,signal});
  assertLabEffect();
  const record = LabCheckResultSchema.parse({ id, name, repository: repo.alias, revision, ...result, createdAt: Date.now() });
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
