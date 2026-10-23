import type { MeritRouter } from "../core/service.js";
import { WorkerTaskSchema, type WorkerTask } from "../core/task.js";
import { MeritRouterError } from "../core/errors.js";
import { supervisionPolicy } from "../admin/client-supervision.js";

/** Per-connection delivery state; never alters the first tool result block. */
export function clientSupervisionFeedback(sy: MeritRouter) {
  let delivered = JSON.stringify(supervisionPolicy(sy));
  return {
    instructions: supervisionPolicy(sy).effectiveInstructions,
    changed() { const policy = supervisionPolicy(sy); const fingerprint = JSON.stringify(policy); if (fingerprint === delivered) return null; delivered = fingerprint; return "MeritRouter external supervision policy updated:\n" + policy.effectiveInstructions; },
    acknowledge() { delivered = JSON.stringify(supervisionPolicy(sy)); },
  };
}


function supervisor(sy: MeritRouter, project: string, profile: WorkerTask["profile"]) {
  return sy.projectContext(project).profiles[profile]?.mode === "supervisor";
}
function parentGuard(sy: MeritRouter, project: string, spec: WorkerTask) {
  if (!spec.parentTaskId) return;
  const parent = sy.tasks.get(spec.parentTaskId);
  if (!parent || parent.row.project_id !== project || !supervisor(sy, project, parent.spec.profile)) throw new MeritRouterError("config_invalid", "parentTaskId must name a real same-project supervisor");
  if (spec.supervisionScope === "project") throw new MeritRouterError("config_invalid", "A child task cannot declare project supervision scope");
}
function projectGuard(sy: MeritRouter) {
  if (!supervisionPolicy(sy).dispatch_final_supervisor) throw new MeritRouterError("usage", "Dispatching a final project supervisor is disabled. Use supervisionScope: subtask for bounded delegation; Claude/Codex retains final project completion.");
}
/** Validate the entire MCP batch before any submission can mutate rows. */
export function scopedMcpTasks(sy: MeritRouter, project: string, raw: unknown[]) {
  return raw.map(value => {
    const spec = WorkerTaskSchema.parse(value);
    parentGuard(sy, project, spec);
    if (!supervisor(sy, project, spec.profile)) {
      if (spec.supervisionScope) throw new MeritRouterError("config_invalid", "supervisionScope applies only to supervisor-mode tasks");
      return spec;
    }
    spec.supervisionScope ??= "subtask";
    if (spec.supervisionScope === "project") projectGuard(sy);
    return spec;
  });
}
export function guardMcpResume(sy: MeritRouter, project: string, id: string) {
  const task = sy.tasks.get(id);
  if (!task || task.row.project_id !== project) throw new MeritRouterError("not_found", `unknown task ${id}`);
  parentGuard(sy, project, task.spec);
  if (supervisor(sy, project, task.spec.profile) && !task.spec.parentTaskId && task.spec.supervisionScope !== "subtask") projectGuard(sy);
}
export function supervisionDispatch(spec: Pick<WorkerTask, "supervisionScope" | "parentTaskId">) {
  return { supervisionScope: spec.supervisionScope ?? "subtask", finalOwner: spec.supervisionScope === "project" ? "meritrouter" : spec.parentTaskId ? "parent-supervisor" : "external-client" };
}
