import { z } from "zod";
import picomatch from "picomatch";
import type { Actor } from "../attribution/index.js";
import type { Principal } from "./access.js";
import { Brain, BrainError } from "./brain.js";
import { MemoryRecordSchema, memoryRecordPath, parseMemoryRecord, renderMemoryRecord, type MemoryRecord } from "./memory-record.js";

export const MemoryWriteInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/), kind: z.enum(["user_preference", "project_fact", "decision", "empirical_lesson"]),
  body: z.string().trim().min(1).max(20_000),
  source: MemoryRecordSchema.shape.source,
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  supersedes: z.string().min(1).nullable().default(null),
}).strict();
export type MemoryWriteInput = z.input<typeof MemoryWriteInputSchema>;
const expectedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
/** Resolved by the trusted initiating client adapter, never constructed from model tool arguments. */
export interface AuthorizedPreferenceInstruction { actor: Actor; originalInstruction: string; sourceRef: string; scope: "global" | "project"; project: string; expiresAt: number; operation: "write" | "revoke"; id: string }
export type PreferenceAuthorizationResolver = (authorizationRef: string) => AuthorizedPreferenceInstruction | null;
export const AuthorizedPreferenceInstructionSchema = z.object({
  actor: z.object({ agent: z.string().min(1), role: z.string().min(1), model: z.string().nullable().optional(), task: z.string().nullable().optional(), job: z.string().nullable().optional(), tier: z.string().nullable().optional(), request: z.string().nullable().optional() }).strict(),
  originalInstruction: z.string().min(1).max(20_000), sourceRef: z.string().min(1).max(20_000),
  scope: z.enum(["global", "project"]), project: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  expiresAt: z.number().int().nonnegative(), operation: z.enum(["write", "revoke"]), id: MemoryWriteInputSchema.shape.id,
}).strict();

/** Scoped Git-backed memory. Global preference authority is a separate trusted capability. */
export class MemoryPreferences {
  constructor(private readonly brain: Brain, private readonly resolveAuthorization: PreferenceAuthorizationResolver, private readonly now: () => number = Date.now) {}

  private record(input: MemoryWriteInput, actor: Actor, scope: MemoryRecord["scope"], previous: MemoryRecord | null): MemoryRecord {
    const parsed = MemoryWriteInputSchema.parse(input), now = this.now();
    if (previous && (previous.kind !== parsed.kind || JSON.stringify(previous.scope) !== JSON.stringify(scope))) throw new BrainError("Memory identity/scope/kind cannot change during update");
    return MemoryRecordSchema.parse({ ...parsed, schemaVersion: 1, scope, status: "active", revision: (previous?.revision ?? 0) + 1, author: { id: actor.agent, role: actor.role, taskId: actor.task ?? null, model: actor.model ?? null }, createdAt: previous?.createdAt ?? now, updatedAt: now });
  }

  async writeProject(p: Principal, actor: Actor, input: MemoryWriteInput, expectedDigest: string | null) {
    expectedDigestSchema.parse(expectedDigest);
    input = MemoryWriteInputSchema.parse(input);
    if (p.kind === "agent" && p.role !== "supervisor") throw new BrainError("Workers propose memory in their reports; supervisors maintain project memory");
    if (input.kind === "user_preference") throw new BrainError("Use the trusted initiating instruction capability to write user preferences");
    const scope = { kind: "project" as const, project: this.brain.project };
    const path = memoryRecordPath({ ...input, scope });
    if (p.kind === "agent" && !p.grants.some(g => (g.mode === "write" || g.mode === "admin") && picomatch(g.pattern, { dot: false, nocase: true })(path))) throw new BrainError("Supervisor lacks scoped project-memory write authority");
    const previous = this.brain.exists(path) ? parseMemoryRecord(this.brain.read(p, path).content) : null;
    const record = this.record(input, actor, scope, previous);
    // Reserved paths refuse raw agent writes; this narrow service enforces role/scope/schema
    // before invoking the internal managed-write capability, preserving the real actor.
    return this.brain.write({ kind: "human", name: "managed project memory" }, actor, path, renderMemoryRecord(record), `Memory ${input.id}`, { expectedDigest });
  }

  async writePreference(authorizationRef: string, input: Omit<MemoryWriteInput, "kind" | "source">, expectedDigest: string | null) {
    expectedDigestSchema.parse(expectedDigest);
    input = MemoryWriteInputSchema.omit({ kind: true, source: true }).parse(input);
    const resolved = AuthorizedPreferenceInstructionSchema.safeParse(this.resolveAuthorization(authorizationRef));
    const auth = resolved.success ? resolved.data : null;
    if (!auth || auth.expiresAt <= this.now() || auth.project !== this.brain.project || auth.operation !== "write" || auth.id !== input.id || !auth.originalInstruction.trim() || !auth.sourceRef.trim() || input.body.trim() !== auth.originalInstruction.trim()) throw new BrainError("A current trusted initiating user instruction bound to this preference ID and exact literal content is required");
    const scope = auth.scope === "global" ? { kind: "global" as const } : { kind: "project" as const, project: auth.project };
    const canonical: MemoryWriteInput = { ...input, kind: "user_preference", source: { kind: "user_instruction", ref: auth.sourceRef, originalInstruction: auth.originalInstruction } };
    const path = memoryRecordPath({ id: input.id, kind: "user_preference", scope });
    const principal: Principal = { kind: "human", name: `authorized preference:${auth.sourceRef}` };
    const previous = this.brain.exists(path) ? parseMemoryRecord(this.brain.read(principal, path).content) : null;
    const record = this.record(canonical, auth.actor, scope, previous);
    return this.brain.write(principal, auth.actor, path, renderMemoryRecord(record), `User preference ${input.id}`, { expectedDigest });
  }

  async revokePreference(authorizationRef: string, id: string, expectedDigest: string) {
    expectedDigestSchema.unwrap().parse(expectedDigest);
    const resolved = AuthorizedPreferenceInstructionSchema.safeParse(this.resolveAuthorization(authorizationRef));
    const auth = resolved.success ? resolved.data : null;
    if (!auth || auth.expiresAt <= this.now() || auth.project !== this.brain.project || auth.operation !== "revoke" || auth.id !== id) throw new BrainError("A current trusted initiating revocation instruction bound to this preference ID is required");
    const scope = auth.scope === "global" ? { kind: "global" as const } : { kind: "project" as const, project: auth.project };
    const path = memoryRecordPath({ id: MemoryWriteInputSchema.shape.id.parse(id), kind: "user_preference", scope });
    const principal: Principal = { kind: "human", name: `authorized preference:${auth.sourceRef}` };
    const current = parseMemoryRecord(this.brain.read(principal, path).content);
    if (!current || current.kind !== "user_preference") throw new BrainError("Not a typed user preference");
    const record = MemoryRecordSchema.parse({ ...current, revision: current.revision + 1, status: "revoked", updatedAt: this.now(), author: { id: auth.actor.agent, role: auth.actor.role, taskId: auth.actor.task ?? null, model: auth.actor.model ?? null } });
    return this.brain.write(principal, auth.actor, path, renderMemoryRecord(record), `Revoke preference ${id}`, { expectedDigest });
  }
}
