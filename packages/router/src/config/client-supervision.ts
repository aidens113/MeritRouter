import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ClientSupervisionSchema } from "./schema.js";

type Workflow = { workflow?: "delegated_delivery" | "direct_tasks" | undefined };
/** The workflow external-client guidance follows: direct tasks unless delivery jobs were chosen. */
export function guidanceWorkflow(policy: Workflow): "delegated_delivery" | "direct_tasks" {
  return policy.workflow ?? "direct_tasks";
}
/** Whether an explicitly started job runs as a v2 delivery job: yes unless direct_tasks was chosen explicitly. */
export function deliveryJobs(policy: Workflow): boolean {
  return policy.workflow !== "direct_tasks";
}

/** Read authored policy by content, including saves sharing the same filesystem timestamp. */
export function readClientSupervision(configPath: string) {
  return z.object({ client_supervision: ClientSupervisionSchema.prefault({}) }).parse(YAML.parse(readFileSync(configPath, "utf8"))).client_supervision;
}
