import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { ensureLabSupervisor } from "../operations/lab-supervisor.js";
import { LabNameSchema } from "../labs/recipe.js";
import type { LabOperationInput } from "../labs/control.js";
import { out, table } from "./terminal.js";

export async function labsCommand(sy: MeritRouter, args: string[], flags: { timeout?: string; confirm?: string; reason?: string }, json: boolean, scope: { project: () => string; list: () => string | undefined }, cliPath: string): Promise<number> {
  const action = args[0] ?? "list";
  if (action === "list") {
    const labs = sy.labs.list(scope.list());
    out(json ? labs.map(lab => sy.labs.publicStatus(lab.project, lab.name)) : table(labs.map(lab => ({ project: lab.project, lab: lab.name, state: lab.state, goal: lab.goal.slice(0, 80) }))), json);
    return 0;
  }
  const project = scope.project();
  const name = LabNameSchema.parse(args[1]);
  if (action === "status") { out(sy.labs.publicStatus(project, name), true); return 0; }
  if (action === "logs") {
    const service = LabNameSchema.parse(args[2]);
    out(sy.labs.logs(project, name, service), json);
    return 0;
  }
  if (action === "operations") { out(sy.labs.publicOperations(project, name), true); return 0; }
  let input: LabOperationInput;
  switch (action) {
    case "create": input = { kind: "create", ...(args[2] ? { goal: args.slice(2).join(" ") } : {}) }; break;
    case "start": input = { kind: "start" }; break;
    case "stop": input = { kind: "stop" }; break;
    case "restart": input = { kind: "restart", ...(args[2] ? { service: LabNameSchema.parse(args[2]) } : {}) }; break;
    case "check": input = { kind: "check", name: LabNameSchema.parse(args[2]) }; break;
    case "refresh": input = { kind: "refresh" }; break;
    case "promote": input = { kind: "promote", by: "human", ...(flags.reason ? { reason: flags.reason } : {}) }; break;
    case "destroy":
      if (flags.confirm !== name) throw new MeritRouterError("usage", `destroy removes this Lab's owned services, worktrees and data; repeat with --confirm ${name}. Branches remain.`);
      input = { kind: "destroy" }; break;
    default: throw new MeritRouterError("usage", "labs: list, create, status, start, stop, restart, check, logs, refresh, promote, destroy, operations, serve, supervisor-start, supervisor-stop, supervisor-status");
  }
  const timeoutMs = flags.timeout === undefined ? 600_000 : z.coerce.number().int().min(1).max(3600).parse(flags.timeout) * 1000;
  await ensureLabSupervisor(sy, cliPath);
  const operation = sy.labs.requestControl(project, name, input, "human:cli");
  // Print the persisted identifier before waiting, so a timeout is recoverable without resubmission.
  if (!json) out(`Labs operation ${operation.id} queued`, false);
  await sy.labs.waitOperation(project, name, operation.id, { timeoutMs });
  out(sy.labs.publicOperation(project, name, operation.id), true);
  return 0;
}
