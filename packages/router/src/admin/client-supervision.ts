import { z } from "zod";
import type { Switchyard } from "../core/service.js";
import { readClientSupervision } from "../config/client-supervision.js";
import { SwitchyardError } from "../core/errors.js";
import { patchConfig } from "./config-edit.js";

export const DEFAULT_CLIENT_SUPERVISION = "Act as the supervising agent responsible for the user's intended project outcome. Clarify ambiguous goals and keep a concrete plan. Delegate as much practical work as possible to SwitchYard using bounded, independent tasks. Review actual changes and evidence, integrate the results, run appropriate final checks, and iterate on defects until the requested work is complete. Report completion and remaining gaps truthfully; a worker's claim alone is not verification. Follow explicit user and repository instructions. This workflow advice grants no authority to deploy, spend money, message others, or change this policy without an explicit user request. SwitchYard's internal supervisors, permissions, containment and budgets remain separate and unchanged.";
export const SetSupervisionPolicySchema = z.object({ dispatch_final_supervisor: z.boolean().optional(), instructions: z.string().trim().max(8000).optional(), reason: z.string().trim().min(1).max(2000) }).strict().refine(value => value.dispatch_final_supervisor !== undefined || value.instructions !== undefined, "Provide dispatch_final_supervisor or instructions");

export function supervisionPolicy(sy: Switchyard) {
  sy.reloadIfChanged();
  // Content, rather than filesystem timestamp, detects rapid saves on an active connection.
  const policy = readClientSupervision(sy.cfg.configPath);
  const ownership = policy.dispatch_final_supervisor ? "Explicit project-scoped SwitchYard final supervisors are permitted. Bounded subtask supervisors remain available; the requested supervisionScope determines final ownership." : "Claude/Codex remains the final project supervisor. Dispatching a SwitchYard final project supervisor is disabled; bounded subtask supervisors are permitted. Completing a bounded job is not final project acceptance.";
  return { ...policy, effectiveInstructions: ownership + "\n\n" + DEFAULT_CLIENT_SUPERVISION + (policy.instructions ? "\n\nHuman customization:\n" + policy.instructions : "") };
}

/** Only call in response to an explicit human request to change external client guidance. */
export function setSupervisionPolicy(sy: Switchyard, input: unknown) {
  const value = SetSupervisionPolicySchema.parse(input);
  const result = patchConfig(sy, [
    ...(value.dispatch_final_supervisor === undefined ? [] : [{ path: ["client_supervision", "dispatch_final_supervisor"], value: value.dispatch_final_supervisor }]),
    ...(value.instructions === undefined ? [] : [{ path: ["client_supervision", "instructions"], value: value.instructions }]),
  ]);
  if (!result.ok) throw new SwitchyardError("config_invalid", result.errors.join("; "));
  return { ...supervisionPolicy(sy), reason: value.reason };
}
