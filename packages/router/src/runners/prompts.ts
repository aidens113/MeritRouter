import type { WorkerTask } from "../core/task.js";
import { OUTPUT_CONTRACT } from "../core/worker-output.js";

export function systemPrompt(role: string): string {
  return `You are a bounded worker delegated one task by a supervising engineer. ${role}
Work only on the stated goal. Do not invent files, line numbers, or results.

${OUTPUT_CONTRACT}`;
}

export function taskBrief(spec: WorkerTask): string {
  const criteria = spec.constraints.acceptanceCriteria.map((c, i) => `  [${i}] ${c}`).join("\n");
  const schema = spec.constraints.outputSchema
    ? `\nThe "data" field is required and must validate against this JSON Schema:\n${JSON.stringify(spec.constraints.outputSchema)}\n`
    : "";
  return `Goal:\n${spec.goal}\n\nAcceptance criteria (assess each by index):\n${criteria}\n${schema}`;
}
