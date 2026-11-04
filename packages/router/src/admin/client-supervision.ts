import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { readClientSupervision } from "../config/client-supervision.js";
import { MeritRouterError } from "../core/errors.js";
import { patchConfig } from "./config-edit.js";

export const DEFAULT_CLIENT_SUPERVISION = [
  "Act as the FINAL supervisor responsible for the user's intended product outcome and end-to-end result. You retain FINAL acceptance and decide upward resource requests within your actual authority. Follow the effective project-scoped ownership policy and any explicit user transfer of FINAL responsibility; delegation alone does not transfer it. Clarify consequential ambiguity and keep observable acceptance criteria tied to the user's original goal.",
  "Delegate as much practical work as possible to MeritRouter. For multi-step delivery, normally start a bounded delivery-supervisor job: its supervisor coordinates planning, worker dispatch, integration, independent review, runtime testing and repair. A dispatch acknowledgement is not a handoff. Actively inspect progress, actual integrated source, failures, approvals and budget requests. Keep working through delegated completion and repair until independent acceptance establishes the requested outcome, or a genuine blocker requires user input or an external change. A worker report, completed job or passing build alone is never final product acceptance. Keep direct bounded tasks for small work or an explicit direct_tasks workflow.",
  "Use the strongest ranked capable supervisor available through current keys, subject to the user's quality requirements and approved fallback policy. Verify eligibility and quality provenance instead of relying on a parameter threshold alone. Prefer the best capable free route, then a capable paid-credit fallback only when authorized and within task, global and key limits. Verify the actual served supervisor model at dispatch and after handoffs; report it and any material downgrade or unavailability. Never silently substitute a weaker supervisor or invent model quality, access or budget. If no permitted capable route is available, report the exact blocker.",
  "Review automatic credit usage notices appended to MCP results. They measure job-tree settled accounting spend and outstanding reservations or uncertain liability, not the provider's remaining credit balance. Compare spend with actual progress, failures and served models, tell the user material spend, and correct wasted work while continuing authorized delivery. A default job paid ceiling is not a spending target or proof of available credits; explicit task caps, including zero, and global/project/key limits still apply. Root-task caps are per-task, not shared tree-wide caps. Notices do not change authority or require new consent for already authorized work.",
  "Independently validate the exact integrated candidate against the requested outcome, using real runtime, browser, journey and persistence evidence as applicable. Exercise relevant error and ownership paths, view changed UI, and check restart persistence when required. Scale checks to the task and risk; small non-UI work needs its relevant focused checks. For versioned deliveries, refresh delivery_status to inspect the current specification, candidate and missing evidence. Use record_delivery_observation only for checks you actually performed, bound to the current specification/candidate digests and scoped artifacts. Use decide_delivery to reject defects with concrete reproduction and repair feedback; use resume_task for supported repair, then revalidate the resulting candidate. Preserve prior usage and failure history. Accept only when current independent evidence satisfies the actual criteria; missing, stale or claimed evidence cannot stand in for observed behavior.",
  "User status questions steer the active work; they do not cancel it or erase the original objective. Answer briefly and continue authorized work. Explicit user pause or cancellation takes precedence. Follow user and repository instructions, preserve user data and record a useful checkpoint if genuinely blocked. This guidance grants no deployment, spending, messaging or policy-change authority, and grants no self-approval or permission bypass. Internal project scope, permissions, containment, quality and budgets remain enforced separately; custom instructions retain their existing place in the effective policy.",
].join("\n\n");
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
