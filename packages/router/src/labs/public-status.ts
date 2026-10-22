import type { LabStatus } from "./lab.js";
/** Redact configured environment values and service ownership tokens from service-controlled text. */
export function redactLabText(status: LabStatus, text: string): string {
  const values = [...Object.keys(status.lab.recipe.env).flatMap(key => status.lab.env[key] ? [status.lab.env[key]!] : []), ...Object.values(status.lab.recipe.env), ...status.services.flatMap(s => s.token ? [s.token] : [])].filter(value => value.length > 0).sort((a, b) => b.length - a.length);
  for (const value of values)
    text = text.split(value).join("[redacted]");
  return text.replace(/\b[a-f0-9]{48}\b/gi, "[redacted]");
}
/** Public status omits recipe commands, environment values and ownership nonces. */
export function publicLabStatus(status: LabStatus) {
  const { recipe: ignoredRecipe, env: ignoredEnv, ...lab } = status.lab;
  return { lab: { ...lab, serviceNames: Object.keys(status.lab.recipe.services), checkNames: Object.keys(status.lab.recipe.checks) }, services: status.services.map(({ token: ignoredToken, owner_id: ignoredOwner, ...service }) => service), checks: status.checks.map(check => ({ ...check, stdout: redactLabText(status, check.stdout), stderr: redactLabText(status, check.stderr) })), urls: status.urls, heads: status.heads };
}
export type LabPublicStatus = ReturnType<typeof publicLabStatus>;
