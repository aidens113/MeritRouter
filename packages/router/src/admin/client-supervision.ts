import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { readClientSupervision } from "../config/client-supervision.js";
import { MeritRouterError } from "../core/errors.js";
import { patchConfig } from "./config-edit.js";

export const DEFAULT_CLIENT_SUPERVISION = "Act as the FINAL supervisor responsible for the user's intended product outcome. Clarify consequential product ambiguity and use a versioned specification with observable acceptance criteria. Delegate as much practical work as possible to MeritRouter. For multi-step delivery, normally start a bounded delivery-supervisor job: its supervisor owns planning, worker dispatch, integration, independent review, runtime testing and repair before returning a candidate and criterion-linked evidence. You retain FINAL acceptance and decide upward resource requests. Review the running product and actual evidence; passing builds or worker completion alone do not establish usability. Keep direct bounded tasks for small work or an explicit direct_tasks workflow. Follow user and repository instructions. This guidance grants no deployment, spending, messaging or policy-change authority. Internal permissions, containment and budgets remain enforced separately.";
export const SetSupervisionPolicySchema = z.object({ dispatch_final_supervisor: z.boolean().optional(), workflow: z.enum(["delegated_delivery", "direct_tasks"]).optional(), instructions: z.string().trim().max(8000).optional(), reason: z.string().trim().min(1).max(2000) }).strict().refine(value => value.dispatch_final_supervisor !== undefined || value.instructions !== undefined || value.workflow !== undefined, "Provide dispatch_final_supervisor, workflow or instructions");

export function supervisionPolicy(sy: MeritRouter) {
  sy.reloadIfChanged();
  // Content, rather than filesystem timestamp, detects rapid saves on an active connection.
  const policy = readClientSupervision(sy.cfg.configPath);
  const ownership = policy.dispatch_final_supervisor ? "Explicit project-scoped MeritRouter final supervisors are permitted. Bounded subtask supervisors remain available; the requested supervisionScope determines final ownership." : "Claude/Codex remains the final project supervisor. Dispatching a MeritRouter final project supervisor is disabled; bounded subtask supervisors are permitted. Completing a bounded job is not final project acceptance.";
  const workflow = policy.workflow === "direct_tasks" ? "Selected workflow: direct_tasks. Coordinate bounded tasks directly; retain FINAL product acceptance." : "Selected workflow: delegated_delivery. Use MeritRouter delivery supervisors for multi-step work; you remain FINAL supervisor.";
  return { ...policy, effectiveInstructions: ownership + "\n\n" + workflow + "\n\n" + DEFAULT_CLIENT_SUPERVISION + (policy.instructions ? "\n\nHuman customization:\n" + policy.instructions : "") };
}

/** Only call in response to an explicit human request to change external client guidance. */
export function setSupervisionPolicy(sy: MeritRouter, input: unknown) {
  const value = SetSupervisionPolicySchema.parse(input);
  const result = patchConfig(sy, [
    ...(value.workflow === undefined ? [] : [{ path: ["client_supervision", "workflow"], value: value.workflow }]),
    ...(value.dispatch_final_supervisor === undefined ? [] : [{ path: ["client_supervision", "dispatch_final_supervisor"], value: value.dispatch_final_supervisor }]),
    ...(value.instructions === undefined ? [] : [{ path: ["client_supervision", "instructions"], value: value.instructions }]),
  ]);
  if (!result.ok) throw new MeritRouterError("config_invalid", result.errors.join("; "));
  return { ...supervisionPolicy(sy), reason: value.reason };
}
