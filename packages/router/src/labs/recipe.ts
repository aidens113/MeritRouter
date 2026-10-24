import { BrowserCheckSchema } from "./browser-schema.js";
import { BrowserJourneyCheckSchema } from "./browser-journey-schema.js";
import { z } from "zod";
export const LabNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const Name = LabNameSchema;
const Command = z.string().trim().min(1).max(16000);
export const LabsConfigSchema = z.object({
  max_active: z.number().int().min(1).max(100).default(4),
  max_services: z.number().int().min(1).max(1000).default(16),
  port_range: z.tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)]).default([5100, 5999]),
  idle_stop_minutes: z.number().positive().max(10080).default(30),
  setup_timeout_seconds: z.number().positive().max(86400).default(300),
  check_timeout_seconds: z.number().positive().max(86400).default(300),
  service_ready_timeout_seconds: z.number().positive().max(600).default(30),
  max_restarts: z.number().int().min(0).max(20).default(3),
  restart_backoff_ms: z.number().int().min(10).max(60000).default(500),
  keep_task_worktrees_days: z.number().int().min(0).max(365).default(7),
}).strict().refine((c) => c.port_range[0] <= c.port_range[1], "port_range must ascend");
export type LabsConfig = z.infer<typeof LabsConfigSchema>;
const TaskLabPolicySchema = z.object({
  enabled: z.boolean().default(false),
  checks: z.array(Name).max(10).default([]),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks).size !== value.checks.length)
    ctx.addIssue({ code: "custom", path: ["checks"], message: "ephemeral check names must be unique" });
  if (value.enabled && !value.checks.length)
    ctx.addIssue({ code: "custom", path: ["checks"], message: "enabled ephemeral checks require a nonempty human allowlist" });
});
export const ProjectLabsSchema = z.object({
  max_active: z.number().int().min(1).max(100).optional(),
  promotion: z.enum(["manual", "supervisor", "auto"]).default("manual"),
  ephemeral: TaskLabPolicySchema.default({ enabled: false, checks: [] }),
}).strict();
const Check = z.union([BrowserCheckSchema, BrowserJourneyCheckSchema, Command, z.object({ command: Command, repo: Name.optional(), on_integrate: z.boolean().default(false) }).strict()]);
const Ready = z.union([z.object({ http: z.string().min(1).max(2000) }).strict(), z.object({ tcp: Name }).strict()]);
export const LabRecipeSchema = z.object({
  ports: z.array(Name).max(32).default([]), data: z.array(Name).max(32).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16000)).default({}),
  setup: z.array(z.union([Command, z.object({ repo: Name, command: Command }).strict()])).max(100).default([]),
  services: z.record(Name, z.object({ repo: Name, command: Command, ready: Ready.optional(), after: z.array(Name).default([]), restart_on_integrate: z.boolean().default(true) }).strict()).default({}),
  checks: z.record(Name, Check).default({}),
}).strict().superRefine((v, ctx) => {
  for (const key of ["ports", "data"] as const)
    if (new Set(v[key]).size !== v[key].length)
      ctx.addIssue({ code: "custom", path: [key], message: "names must be unique" });
  for (const [name, service] of Object.entries(v.services)) {
    for (const dep of service.after)
      if (!Object.hasOwn(v.services, dep) || dep === name)
        ctx.addIssue({ code: "custom", path: ["services", name, "after"], message: `unknown or self dependency ${dep}` });
    if (service.ready && "tcp" in service.ready && !v.ports.includes(service.ready.tcp))
      ctx.addIssue({ code: "custom", path: ["services", name, "ready"], message: "tcp readiness must name a declared port" });
    if (service.ready && "http" in service.ready && !/^http:\/\/127\.0\.0\.1:\{port\.[a-z0-9-]+\}(?:\/|$)/.test(service.ready.http))
      ctx.addIssue({ code: "custom", path: ["services", name, "ready"], message: "HTTP readiness must use http://127.0.0.1:{port.name}" });
  }
  const seen = new Set<string>();
  const visit = (name: string, chain: Set<string>) => {
    if (chain.has(name)) {
      ctx.addIssue({ code: "custom", path: ["services"], message: "service dependency cycle" });
      return;
    }
    if (seen.has(name))
      return;
    chain.add(name);
    for (const dep of v.services[name]?.after ?? [])
      visit(dep, new Set(chain));
    seen.add(name);
  };
  for (const name of Object.keys(v.services))
    visit(name, new Set());
  for (const [name, check] of Object.entries(v.checks)) {
    if (typeof check !== "string" && "kind" in check && check.kind === "browser") {
      const service = v.services[check.service];
      if (!service?.ready || !("http" in service.ready)) ctx.addIssue({code:"custom",path:["checks",name,"service"],message:"browser check must name a declared HTTP service"});
    }
  }
  const templates = JSON.stringify(v);
  for (const match of templates.matchAll(/\{(port\.[^{}]+|lab\.[^{}]+|repo\.[^{}]+)\}/g)) {
    const key = match[1]!;
    if (key.startsWith("port.") && !v.ports.includes(key.slice(5)))
      ctx.addIssue({ code: "custom", message: `unknown placeholder ${key}` });
    if (key.startsWith("lab.data.") && !v.data.includes(key.slice(9)))
      ctx.addIssue({ code: "custom", message: `unknown placeholder ${key}` });
    if (key.startsWith("lab.") && !key.startsWith("lab.data.") && !["lab.name", "lab.project", "lab.root"].includes(key))
      ctx.addIssue({ code: "custom", message: `unknown placeholder ${key}` });
  }
});
export type LabRecipe = z.infer<typeof LabRecipeSchema>;
export function validateRecipe(recipe: unknown, repositories: string[]): LabRecipe {
  const r = LabRecipeSchema.parse(recipe);
  const check = (alias: string) => {
    if (!repositories.includes(alias))
      throw new Error(`lab recipe refers to unknown repository ${alias}`);
  };
  for (const service of Object.values(r.services))
    check(service.repo);
  for (const setup of r.setup)
    if (typeof setup !== "string")
      check(setup.repo);
  for (const value of Object.values(r.checks))
    if (typeof value !== "string" && value.repo)
      check(value.repo);
  for (const match of JSON.stringify(r).matchAll(/\{repo\.([^{}]+)\}/g))
    check(match[1]!);
  return r;
}
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(port\.[^{}]+|lab\.[^{}]+|repo\.[^{}]+)\}/g, (_, key: string) => {
    if (values[key] === undefined)
      throw new Error(`unknown lab placeholder ${key}`);
    return values[key]!;
  });
}
