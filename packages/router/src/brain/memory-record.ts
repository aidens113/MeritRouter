import YAML from "yaml";
import { z } from "zod";

const text = z.string().trim().min(1).max(20_000);
export const MemoryRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/),
  kind: z.enum(["user_preference", "project_fact", "decision", "empirical_lesson"]),
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("global") }).strict(), z.object({ kind: z.literal("project"), project: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/) }).strict()]),
  status: z.enum(["active", "superseded", "revoked"]), revision: z.number().int().positive(),
  source: z.object({ kind: z.enum(["user_instruction", "observation", "decision"]), ref: text, originalInstruction: z.string().min(1).max(20_000).refine(v => v.trim().length > 0, "User instruction must not be blank").optional() }).strict(),
  author: z.object({ id: text, role: text, taskId: text.nullable(), model: text.nullable() }).strict(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative().nullable(),
  supersedes: text.nullable(), body: text,
}).strict().superRefine((v, ctx) => {
  if (v.updatedAt < v.createdAt) ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "Update precedes creation" });
  if (v.status === "active" && v.expiresAt !== null && v.expiresAt <= v.updatedAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must follow update" });
  if (v.kind === "user_preference" && (v.source.kind !== "user_instruction" || !v.source.originalInstruction)) ctx.addIssue({ code: "custom", path: ["source"], message: "Preferences preserve the original user instruction" });
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export function memoryRecordPath(record: Pick<MemoryRecord, "scope" | "id" | "kind">): string {
  if (record.scope.kind === "global") {
    if (record.kind !== "user_preference") throw new Error("Global inferred lessons require the existing independent promotion service");
    return `global/preferences/${record.id}.md`;
  }
  return `projects/${record.scope.project}/memory/${record.kind === "user_preference" ? "preferences/" : ""}${record.id}.md`;
}
export function renderMemoryRecord(value: unknown): string {
  const { body, ...metadata } = MemoryRecordSchema.parse(value);
  return `---\n${YAML.stringify({ meritrouterMemory: metadata })}---\n\n${body}\n`;
}
export function parseMemoryRecord(content: string): MemoryRecord | null {
  if (content.length > 128_000) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) return null;
  try {
    const parsed: unknown = YAML.parse(match[1]!);
    if (!parsed || typeof parsed !== "object" || !("meritrouterMemory" in parsed)) return null;
    const metadata = (parsed as { meritrouterMemory: unknown }).meritrouterMemory;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const record = MemoryRecordSchema.safeParse({ ...metadata, body: match[2]!.trim() });
    return record.success ? record.data : null;
  } catch { return null; }
}
