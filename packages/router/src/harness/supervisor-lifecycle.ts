import { z } from "zod";
import type { RunContext } from "../runners/types.js";
import { PlanStore, type PlanNode } from "../storage/plans.js";
import { ProductDeliveries } from "../verification/product-delivery.js";
import type { HarnessTool } from "./tools.js";

/** Discovery is deliberately small and task-wide: reopening a session cannot reset it. */
export const SUPERVISOR_DISCOVERY_REQUESTS = 6;
const coordination = ["set_delivery_spec", "advance_delivery_stage", "plan_work", "delivery_status", "ask_user", "brain_set_current_state", "brain_set_job_section", "brain_append_ledger", "await_tasks", "task_result", "cancel_tasks", "worker_action_requests", "decide_worker_action", "budget_requests", "decide_budget_request", "request_more_budget"];
const commandOperations = new Set(["run_command", "run_recipe", "run_checks", "run_check", "lab_check", "lab_restart", "lab_promote", "integrate_task"]);
const list = z.array(z.string());
const normalizedLabel = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Match the supervisor tools' existing encoded-array compatibility before applying guards. */
function delegationItems(value: unknown, name: string): Array<Record<string, unknown>> {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${name} must be a JSON array of objects`);
      throw error;
    }
  }
  const parsed = z.array(z.record(z.string(), z.unknown())).safeParse(input);
  if (!parsed.success) throw new Error(`${name} must be an array of objects`);
  return parsed.data;
}

function state(ctx: RunContext) {
  const project = ctx.tasks.projectOf(ctx.taskId) ?? ctx.cfg.brain.project;
  return { delivery: new ProductDeliveries(ctx.tasks.db).status(ctx.taskId, project), plan: new PlanStore(ctx.tasks.db).latest(ctx.taskId) };
}

export function supervisorToolPolicy(ctx: RunContext) {
  if (ctx.spec.deliveryVersion !== 2) return null;
  const { delivery, plan } = state(ctx);
  const assigned = plan && ctx.tasks.childrenOf(ctx.taskId).some(child => plan.nodes.some(node => node.label === child.spec.label));
  if (assigned && delivery && ["plan", "implement", "integrate", "validate", "handoff"].includes(delivery.stage)) return null;
  if (ctx.gate.admission.taskTotals(ctx.taskId).requests < SUPERVISOR_DISCOVERY_REQUESTS) return null;
  const canDispatch = !!plan && !!delivery && ["plan", "implement", "integrate", "validate"].includes(delivery.stage);
  return { allowedToolNames: canDispatch ? [...coordination, "delegate"] : coordination, notice: `Discovery allowance exhausted. Persist the observable delivery specification with set_delivery_spec, advance prepare/plan, and publish plan_work (dispatch:false records a draft without running workers). Dispatch bounded planned work with plan_work dispatch:true, or delegate the first planned phase using its exact recorded brief; an undispatched draft alone does not resume discovery. If essential information is unavailable, ask_user or finish_job blocked with the exact blocker. Do not run environment checks or repeat discovery.` };
}

function containsCommand(name: string, args: Record<string, unknown>): boolean {
  if (commandOperations.has(name)) return true;
  if (name === "lab_http") return !["GET", "HEAD"].includes(String(args.method ?? "GET"));
  if (name !== "batch" || !Array.isArray(args.items)) return false;
  return args.items.some(item => {
    if (!item || typeof item !== "object") return false;
    const value = item as Record<string, unknown>;
    return containsCommand(String(value.operation), (value.args ?? {}) as Record<string, unknown>);
  });
}

/** Called before any tool reaches its effect, including mixed batch command operations. */
export function assertSupervisorTool(ctx: RunContext, tool: Pick<HarnessTool, "def" | "sideEffect">, args: Record<string, unknown>): void {
  if (ctx.spec.deliveryVersion !== 2) return;
  const name = tool.def.function.name;
  const policy = supervisorToolPolicy(ctx);
  if (policy && !policy.allowedToolNames.includes(name)) throw new Error(`delivery_progress_required: ${policy.notice}`);
  const { delivery, plan } = state(ctx);
  const planned = !!plan && !!delivery && ["plan", "implement", "integrate", "validate"].includes(delivery.stage);
  if (((name !== "batch" && tool.sideEffect === "command") || containsCommand(name, args)) && !planned) throw new Error("delivery_plan_required: publish a specification and plan before requesting host commands; read-only repository discovery remains available");
  if (name !== "delegate" && name !== "plan_work") return;
  const field = name === "delegate" ? "tasks" : "nodes";
  const items = delegationItems(args[field], field);
  if (name === "plan_work" && args.dispatch === false) return;
  const execution = items.some(item => item.profile === "implement" || item.profile === "supervise" || (Array.isArray(item.checks) && item.checks.length) || (Array.isArray(item.lab_checks) && item.lab_checks.length));
  if (execution && (!delivery || !["plan", "implement", "integrate", "validate"].includes(delivery.stage))) throw new Error("delivery_plan_required: specify, prepare and plan before execution; read-only discovery without host checks may run first");
  if (execution && name === "delegate" && !plan) throw new Error("delivery_plan_required: use plan_work to record execution nodes before dispatch");
}

/** Every dispatched execution brief must describe its actual recorded node, not a dummy plan. */
export function assertPlannedBriefs(ctx: RunContext, items: Array<Record<string, unknown>>, defaultRepository: string | undefined): void {
  if (ctx.spec.deliveryVersion !== 2) return;
  const plan = new PlanStore(ctx.tasks.db).latest(ctx.taskId);
  for (const item of items) {
    if (!plan && item.profile !== "implement" && item.profile !== "supervise" && !(Array.isArray(item.checks) && item.checks.length) && !(Array.isArray(item.lab_checks) && item.lab_checks.length)) continue;
    const node = plan?.nodes.find(node => node.label === normalizedLabel(item.label));
    if (!node) throw new Error(`delivery_plan_required: record ${String(item.label)} with plan_work before dispatch`);
    const expected: Pick<PlanNode, "profile" | "goal" | "acceptanceCriteria" | "dependsOn" | "allowedPaths" | "checks" | "labChecks" | "writableRepository" | "repairFromTask"> = {
      profile: item.profile as PlanNode["profile"], goal: String(item.goal ?? ""), acceptanceCriteria: list.parse(item.acceptance_criteria),
      dependsOn: list.parse(item.depends_on ?? []).map(normalizedLabel), allowedPaths: item.allowed_paths === undefined ? null : list.parse(item.allowed_paths), checks: list.parse(item.checks ?? []),
      labChecks: list.parse(item.lab_checks ?? []),
      repairFromTask: item.repair_from_task === undefined ? null : z.string().min(1).parse(item.repair_from_task),
      writableRepository: item.profile === "implement" ? String(item.writable_repository ?? defaultRepository ?? "") || null : null,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) if (!same(node[key], expected[key])) throw new Error(`delivery_plan_conflict: ${node.label}.${key} differs from its persisted plan; replan before dispatch`);
  }
}
