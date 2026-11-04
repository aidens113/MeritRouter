import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChatTool } from "../gateway/types.js";

export const SUPERVISOR_SUITE_VERSION = "supervisor-decisions-v3";
export const SUPERVISOR_SUITE_SOURCE = "MeritRouter observed supervisor decision suite";
export const SUPERVISOR_VARIANT = "provider_default";
export const SUPERVISOR_GROUPS = ["planning", "tool_arguments", "dependency_repair", "integration", "review", "final_decision"] as const;

/** Public problems, not answers. These fixtures contain no user's goal, code or memory. */
export const SUPERVISOR_SCENARIOS = [
  { group: "planning", state: "Plan implementation nodes db, api, ui. api requires db; ui requires api. Each writes only src/<label>/**. Include a read-only tests node after ui if it improves verification. Return plan_work arguments {nodes:[{label,profile,allowed_paths,depends_on}]} using implement for writers and inspect for tests. allowed_paths defines WRITE permission only, not read scope. A read-only inspect node must set allowed_paths:[] and depends_on:[\"ui\"]. Each implement writer must use allowed_paths:[\"src/<label>/**\"]." },
  { group: "tool_arguments", state: "A profile worker failed. Delegate a fresh repair limited to src/profile/**, with 4..8 model requests and goal explaining repair. The label profile is already used; no dependency is required. Return delegate arguments {tasks:[{label,profile,goal,allowed_paths,max_requests,depends_on}]} for one implement task." },
  { group: "dependency_repair", state: "scaffold was rejected. scaffold-redo is completed, accepted and integrated. tests and review have not been dispatched. Return plan_work arguments {nodes:[{label,depends_on}]} for tests then review, reading the successful source and keeping review after tests." },
  { group: "integration", state: "feature returned a patch whose current tree differs from the only revision its checks verified. Integration must not claim that unchecked source passed. Choose next action and arguments. Available tools: accept_task, integrate_task, reject_task, finish_job. For rejection use {task_id,reason_code}; feature is the task ID." },
  { group: "review", state: "Review worker change: UPDATE posts SET body=? WHERE id=? uses a caller-supplied post ID but does not constrain owner to the authenticated user. Tests pass but cover only own posts. Choose accept_task or reject_task, arguments {task_id,reason_code}. Task ID is worker." },
  { group: "final_decision", state: "Build and unit tests passed. Wrong-password refusal and restart persistence were not exercised; the requested product requires both. No browser/runtime receipts exist for them. Return finish_job arguments {status,not_verified:[criterion IDs],verified:[criterion IDs]}. status must be one of the exact enum values completed or blocked. completed means every required criterion is verified; blocked means required evidence is still missing. IDs: build, unit_tests, wrong_password, restart_persistence." },
] as const;
export const SUPERVISOR_SUITE_DIGEST = createHash("sha256").update(JSON.stringify({ version: SUPERVISOR_SUITE_VERSION, scenarios: SUPERVISOR_SCENARIOS })).digest("hex");

export const SupervisorDecisionsSchema = z.object({
  decisions: z.array(z.object({ group: z.enum(SUPERVISOR_GROUPS), tool: z.enum(["plan_work", "delegate", "accept_task", "integrate_task", "reject_task", "finish_job"]), arguments: z.record(z.string(), z.unknown()).refine(v => JSON.stringify(v).length <= 8000) }).strict()).length(SUPERVISOR_GROUPS.length),
}).strict().refine(v => new Set(v.decisions.map(d => d.group)).size === SUPERVISOR_GROUPS.length, "Return every scenario once");

export const SUPERVISOR_DECISION_TOOL: ChatTool = { type: "function", function: {
  name: "record_decisions", description: "Record the six sandbox decisions. This tool records data only and grants no real project actions.",
  parameters: { type: "object", properties: { decisions: { type: "array", minItems: 6, maxItems: 6, items: { type: "object", properties: { group: { type: "string", enum: [...SUPERVISOR_GROUPS] }, tool: { type: "string", enum: ["plan_work", "delegate", "accept_task", "integrate_task", "reject_task", "finish_job"] }, arguments: { type: "object" } }, required: ["group", "tool", "arguments"], additionalProperties: false } } }, required: ["decisions"], additionalProperties: false },
} };

const node = z.object({ label: z.string(), profile: z.string(), allowed_paths: z.array(z.string()), depends_on: z.array(z.string()) }).strict();
const rejection = z.object({ task_id: z.string(), reason_code: z.string().trim().min(3).max(1000) }).strict();
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Independent service-owned deterministic grading; model-provided scores are never read. */
export function gradeSupervisorDecisions(raw: unknown): { metrics: Record<string, number>; coverage: number; observations: string[] } {
  const parsed = SupervisorDecisionsSchema.safeParse(raw);
  const metrics: Record<string, number> = Object.fromEntries(SUPERVISOR_GROUPS.map(g => [g, 0]));
  const observations: string[] = [];
  let bonus = 0;
  if (parsed.success) for (const d of parsed.data.decisions) {
    let passed = false;
    try {
      if (d.group === "planning" && d.tool === "plan_work") {
        const args = z.object({ nodes: z.array(node).min(3).max(4) }).strict().parse(d.arguments);
        const byLabel = new Map(args.nodes.map(n => [n.label, n]));
        passed = byLabel.size === args.nodes.length && ["db", "api", "ui"].every((label, i) => {
          const n = byLabel.get(label);
          return n?.profile === "implement" && same(n.allowed_paths, [`src/${label}/**`]) && same(n.depends_on, i ? [i === 1 ? "db" : "api"] : []);
        });
        const tests = byLabel.get("tests");
        if (tests) {
          passed = passed && tests.profile === "inspect" && tests.allowed_paths.length === 0 && same(tests.depends_on, ["ui"]);
          if (passed) bonus++;
        }
        if (args.nodes.some(n => !["db", "api", "ui", "tests"].includes(n.label))) passed = false;
      } else if (d.group === "tool_arguments" && d.tool === "delegate") {
        const args = z.object({ tasks: z.array(z.object({ label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), profile: z.literal("implement"), goal: z.string().trim().min(1), allowed_paths: z.array(z.string()), max_requests: z.number().int().min(4).max(8), depends_on: z.array(z.string()) }).strict()).length(1) }).strict().parse(d.arguments);
        passed = args.tasks[0]!.label !== "profile" && same(args.tasks[0]!.allowed_paths, ["src/profile/**"]) && args.tasks[0]!.depends_on.length === 0;
      } else if (d.group === "dependency_repair" && d.tool === "plan_work") {
        const args = z.object({ nodes: z.array(z.object({ label: z.string(), depends_on: z.array(z.string()) }).strict()).length(2) }).strict().parse(d.arguments);
        const tests = args.nodes.find(n => n.label === "tests"), review = args.nodes.find(n => n.label === "review");
        passed = !!tests && !!review && same(tests.depends_on, ["scaffold-redo"]) && review.depends_on.includes("tests") && review.depends_on.every(id => ["tests", "scaffold-redo"].includes(id));
        if (passed && review!.depends_on.includes("scaffold-redo")) bonus++;
      } else if (d.group === "integration" && d.tool === "reject_task") {
        const args = rejection.parse(d.arguments);
        passed = args.task_id === "feature";
      } else if (d.group === "review" && d.tool === "reject_task") {
        const args = rejection.parse(d.arguments);
        passed = args.task_id === "worker";
      } else if (d.group === "final_decision" && d.tool === "finish_job") {
        const args = z.object({ status: z.enum(["completed", "blocked"]), verified: z.array(z.string()), not_verified: z.array(z.string()) }).strict().parse(d.arguments);
        passed = args.status === "blocked" && same(args.not_verified, ["wrong_password", "restart_persistence"]) && args.verified.every(id => ["build", "unit_tests"].includes(id));
        if (passed && same(args.verified, ["build", "unit_tests"])) bonus++;
      }
    } catch { /* A malformed tool argument is an observed failure, never grader authority. */ }
    metrics[d.group] = passed ? 1 : 0;
    observations.push(`${d.group}: ${passed ? "pass" : "fail"}`);
  }
  else observations.push("invalid or incomplete record_decisions tool arguments");
  // Six mandatory decisions plus three structured completeness observations. Vocabulary
  // choices are not evidence of better reasoning. v2 invalidates the former rubric scores.
  metrics.role_points = (Object.values(metrics).reduce((a, b) => a + b, 0) + bonus) / 9 * 100;
  return { metrics, coverage: parsed.success ? SUPERVISOR_GROUPS.length : 0, observations };
}

export const LOCAL_SUPERVISOR_RANKING_POLICY = {
  source: SUPERVISOR_SUITE_SOURCE, suite_version: `${SUPERVISOR_SUITE_VERSION}:${SUPERVISOR_SUITE_DIGEST}`, metric_scale: "observed decision points 0..100; provider_default", rank_metric: "role_points",
  capability_floors: { ...Object.fromEntries(SUPERVISOR_GROUPS.map(g => [g, 1])), role_points: 60 },
};
