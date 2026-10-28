import { z } from "zod";
import YAML from "yaml";
import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { LabPromotionResultSchema } from "../labs/promotion.js";
import { LabNameSchema, validateRecipe } from "../labs/recipe.js";
import { projectInfo } from "./projects.js";
import { readConfigText, writePreparedConfigText } from "./config-edit.js";
import { saveProjectSettings } from "./project-settings.js";
import { ensureLabSupervisor } from "../operations/lab-supervisor.js";
import { ProjectStoreUnavailableError, requireProjectStores, withUnavailable, type WithUnavailable } from "./project-reads.js";

const projectConfig = (sy: MeritRouter, project: string) => ProjectConfigSchema.parse(sy.cfg.projects[project] ?? {});

function validName(value: string) {
  const parsed = LabNameSchema.safeParse(value);
  if (!parsed.success) throw new MeritRouterError("config_invalid", "Lab and service names use lowercase letters, digits and dashes, up to 41 characters.");
  return parsed.data;
}

function scope(sy: MeritRouter, project: string, write = false) {
  const p = projectInfo(sy, project);
  if (write && p.archived) throw new MeritRouterError("usage", `project ${project} is archived: unarchive it before changing labs`);
  return p;
}

const OperationRow = z.object({
  id: z.string(), kind: z.string().min(1).max(100), input_json: z.string().max(1_000_000),
  state: z.enum(["pending", "running", "completed", "failed"]), requested_by: z.string().max(200),
  promotion_state: z.enum(["prepared", "promoted", "conflict", "failed", "partial"]).nullable(),
  error_code: z.string().max(200).nullable(), created_at: z.number().int(), updated_at: z.number().int(),
});
const OperationReason = z.object({ kind: z.string(), reason: z.string().max(2000).optional() });
/** History needs metadata, not full operation results (which would re-read runtime/git status for every row). */
function operationViews(sy: MeritRouter, project: string, name: string, id?: string) {
  const stores = requireProjectStores(sy, project);
  const rows = z.array(OperationRow).parse(stores.db.prepare(`SELECT id,kind,input_json,state,requested_by,error_code,created_at,updated_at,CASE WHEN kind='promote' AND state='completed' AND json_valid(result_json) THEN json_extract(result_json,'$.state') ELSE NULL END AS promotion_state FROM lab_operations WHERE project_id=? AND lab_name=? ${id ? "AND id=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT 20`).all(project, name, ...(id ? [id] : [])));
  return rows.map(row => {
    const input = OperationReason.parse(JSON.parse(row.input_json));
    return { id: row.id, kind: row.kind, state: row.state, requestedBy: row.requested_by,
      ...(row.kind === "promote" && input.kind === "promote" && input.reason ? { promotionReason: sy.labsFor(project).redact(project, name, input.reason) } : {}),
      promotionState: row.promotion_state,
      outcomeMessage: row.promotion_state && ["failed", "partial", "conflict"].includes(row.promotion_state) ? "Promotion did not complete; inspect supervisor logs and the lab check results." : null,
      errorCode: row.error_code, errorMessage: row.error_code ? "Lab operation failed; inspect local supervisor logs for details." : null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  });
}

/** Project-only public detail. Never returns recipe commands, materialized env, tokens or raw operation results. */
export function labDetailView(sy: MeritRouter, project: string, name: string) {
  const p = scope(sy, project);
  validName(name);
  const operations = operationViews(sy, project, name);
  if (!sy.labsFor(project).list(project).some(l => l.name === name)) {
    if (!operations.length) throw new MeritRouterError("not_found", `unknown lab ${name} in project ${project}`);
    return { project, archived: p.archived, status: null, operations };
  }
  // Creation persists its row before allocating placeholders; pending metadata is safe until complete.
  if (sy.labsFor(project).store.get(project, name)?.state === "creating") return { project, archived: p.archived, status: null, operations };
  const status = sy.labsFor(project).publicStatus(project, name);

  return { project, archived: p.archived, status: {
    ...status,
    lab: { ...status.lab, goal: sy.labsFor(project).redact(project, name, status.lab.goal) },
    checks: status.checks.slice(0, 20).map(c => ({ ...c, stdout: c.stdout.slice(-8_000), stderr: c.stderr.slice(-8_000) })),
  }, operations };
}

/** Explicit detail fetch only: expose validated promotion evidence, never arbitrary stored results. */
export function labPromotionView(sy: MeritRouter, project: string, name: string, id: string) {
  scope(sy, project); validName(name);
  const metadata = operationViews(sy, project, name, z.string().min(1).max(200).parse(id))[0];
  if (!metadata || metadata.kind !== "promote" || metadata.state !== "completed") throw new MeritRouterError("not_found", "Completed promotion not found in this project's lab");
  const op = sy.labsFor(project).publicOperation(project, name, id);
  const result = LabPromotionResultSchema.parse(op?.result);
  const text = (value: string) => sy.labsFor(project).redact(project, name, value).slice(0, 2000);
  const revisions = (rows: Record<string, string>) => Object.fromEntries(Object.entries(rows).slice(0, 100).map(([alias, sha]) => [text(alias), text(sha)]));
  const commands = result.commands.filter(command => command.length <= 16000).slice(0, 100);
  return { id, state: result.state, policy: result.policy, heads: revisions(result.heads), targets: revisions(result.targets),
    manualCommands: commands.map(command => sy.labsFor(project).redact(project, name, command)),
    instructionsOmitted: commands.length !== result.commands.length,
    conflicts: Object.fromEntries(Object.entries(result.conflicts).slice(0, 100).map(([alias, paths]) => [text(alias), paths.slice(0, 100).map(text)])),
    checks: result.checks.slice(0, 100).map(check => ({ name: text(check.name), revision: text(check.revision), passed: check.exitCode === 0 && !check.killed })), error: result.error };
}

function labEntry(sy: MeritRouter, project: string, name: string) {
  const detail = labDetailView(sy, project, name);
  if (!detail.status) return { name, ...detail, status: null };
  const { checks: ignoredChecks, ...status } = detail.status;
  return { name, ...detail, status };
}

/**
 * A project's labs. Returns an `unavailableProjects` marker (never throws) when the project's
 * store cannot be read right now, since callers (the panel's project pages) need to show a
 * notice, not crash, for a split-layout project whose store is temporarily unavailable.
 */
export function labsListView(sy: MeritRouter, project: string): WithUnavailable<{ project: string; archived: boolean; configured: boolean; labs: ReturnType<typeof labEntry>[] }> {
  const p = scope(sy, project);
  const configured = !!projectConfig(sy, project).lab;
  let stores: ReturnType<typeof requireProjectStores>;
  try {
    stores = requireProjectStores(sy, project);
  } catch (error) {
    if (!(error instanceof ProjectStoreUnavailableError)) throw error;
    return withUnavailable({ project, archived: p.archived, configured, labs: [] }, [{ project, reason: error.reason }]);
  }
  const names = new Set(sy.labsFor(project).list(project).map(l => l.name));
  const pending = z.array(z.object({ lab_name: LabNameSchema })).parse(stores.db.prepare("SELECT DISTINCT lab_name FROM lab_operations WHERE project_id = ? AND state IN ('pending','running')").all(project));
  for (const row of pending) names.add(row.lab_name);
  return { project, archived: p.archived, configured, labs: [...names].map(name => labEntry(sy, project, name)) };
}

export function labLogs(sy: MeritRouter, project: string, name: string, service: string) {
  scope(sy, project);
  validName(name); validName(service);
  const status = sy.labsFor(project).publicStatus(project, name);
  if (!status.lab.serviceNames.includes(service)) throw new MeritRouterError("not_found", "unknown service in this project's lab");
  return { log: sy.labsFor(project).logs(project, name, service, 200).slice(-64_000) };
}

export function labRecipeView(sy: MeritRouter, project: string) {
  const p = scope(sy, project);
  const recipe = projectConfig(sy, project).lab;
  const { env, ...definition } = recipe ?? { env: {}, ports: [], data: [], setup: [], services: {}, checks: {} };
  return { recipe: definition, configured: !!recipe, envKeys: Object.keys(env), promotion: projectConfig(sy, project).labs.promotion ?? "manual", maxActive: projectConfig(sy, project).labs.max_active ?? null, readOnly: p.archived, legacy: p.legacy };
}

const RecipeSave = z.object({ recipe: z.record(z.string(), z.unknown()), promotion: z.enum(["manual", "supervisor", "auto"]), maxActive: z.number().int().min(1).max(100).nullable() }).strict();
export async function saveLabRecipe(sy: MeritRouter, project: string, input: unknown) {
  const p = scope(sy, project, true);
  const b = RecipeSave.parse(input);
  if (Object.hasOwn(b.recipe, "env")) throw new MeritRouterError("usage", "Environment values stay private; omit env from the recipe editor.");
  const env = projectConfig(sy, project).lab?.env ?? {};
  let recipe: ReturnType<typeof validateRecipe>;
  try { recipe = validateRecipe({ ...b.recipe, env }, p.repositories.map(r => r.alias)); }
  catch (error) { throw new MeritRouterError("config_invalid", (error as Error).message); }
  const policy = { ...projectConfig(sy, project).labs, promotion: b.promotion };
  if (b.maxActive === null) delete policy.max_active;
  else policy.max_active = b.maxActive;
  let result: Awaited<ReturnType<typeof writePreparedConfigText>>;
  if (p.legacy) {
    // One explicit human save converts only this project's repositories and enables its recipe.
    // All other global settings remain in place and keep their existing inheritance behavior.
    const source = readConfigText(sy);
    const doc = YAML.parseDocument(source);
    const repositories = (doc.getIn(["repositories"], true) as YAML.Node | undefined)?.toJSON?.() ?? {};
    doc.deleteIn(["repositories"]);
    doc.setIn(["projects", project], { repositories, lab: recipe, labs: policy });
    if (readConfigText(sy) !== source) throw new MeritRouterError("config_invalid", "The config changed; reload before saving the lab recipe.");
    result = await writePreparedConfigText(sy, doc.toString());
  } else {
    result = saveProjectSettings(sy, project, [{ path: ["lab"], value: recipe }, { path: ["labs"], value: policy }]);
  }
  if (!result.ok) throw new MeritRouterError("config_invalid", result.errors.join("; "));
  return { saved: true };
}

export const HumanLabControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), goal: z.string().max(16000).default("") }).strict(),
  ...(["start", "stop", "destroy", "refresh"] as const).map(action => z.object({ action: z.literal(action) }).strict()),
  z.object({ action: z.literal("restart"), service: LabNameSchema.optional() }).strict(),
  z.object({ action: z.literal("check"), check: LabNameSchema }).strict(),
  z.object({ action: z.literal("promote"), reason: z.string().trim().min(1, "A review reason is required").max(2000) }).strict(),
]);

/** Explicit authenticated human request only. Launches the Labs supervisor, never a model worker. */
export async function requestLabControl(sy: MeritRouter, project: string, name: string, input: unknown) {
  scope(sy, project, true); validName(name);
  const b = HumanLabControlSchema.parse(input);
  if (b.action === "create") {
    if (!projectConfig(sy, project).lab) throw new MeritRouterError("usage", "Configure this project's lab recipe before creating a lab.");
    if (sy.labsFor(project).list(project).some(l => l.name === name)) throw new MeritRouterError("usage", "A lab with this name already exists.");
  } else {
    const status = labDetailView(sy, project, name).status;
    if (!status) throw new MeritRouterError("usage", "Wait for lab creation to finish before requesting controls.");
    if (b.action === "check" && !status.lab.checkNames.includes(b.check)) throw new MeritRouterError("not_found", "unknown declared lab check");
    if (b.action === "restart" && b.service && !status.lab.serviceNames.includes(b.service)) throw new MeritRouterError("not_found", "unknown declared lab service");
  }
  const operation = b.action === "create" ? { kind: "create" as const, goal: b.goal } : b.action === "check" ? { kind: "check" as const, name: b.check } : b.action === "promote" ? { kind: "promote" as const, by: "human" as const, reason: b.reason } : b.action === "restart" ? { kind: "restart" as const, ...(b.service ? { service: b.service } : {}) } : { kind: b.action };
  try { await ensureLabSupervisor(sy); }
  catch (error) { throw new MeritRouterError("usage", `Labs supervisor is unavailable: ${(error as Error).message}`); }
  const queued = sy.labsFor(project).requestControl(project, name, operation, "human:panel");
  const operationView = operationViews(sy, project, name, queued.id)[0];
  if (!operationView) throw new MeritRouterError("not_found", "Queued operation was not found; inspect persisted Labs operations.");
  return { operation: operationView };
}
