# Report: s1-store

Worker report for "Brief: s1-store" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).

## Outcome

Done. The session store, recorder, migration, `RunContext.session`, recording inside `ask()`,
`Switchyard.sessions`, insights functions, and public exports are in place. The new tests and
the existing router tests pass, and typecheck passes.

## What changed and why

New area `packages/router/src/sessions/`:
- `events.ts`: zod schemas for the log envelope `{seq, at, type, data}` and for each event type
  (`started`, `message`, `model_request`, `model_response`, `model_error`, `tool_intent`,
  `tool_outcome`, `note`, `workspace`, `ended`), plus the status and side-effect enums,
  `TOOL_OUTPUT_CAP_BYTES` (16 KB), and `CorruptLine`.
- `recorder.ts`: `SessionRecorder`. Each append validates the event with zod, writes one JSON
  line (open "a", write, `fsyncSync`, close), then updates the `sessions` counters and inserts
  the `session_events` row in one `BEGIN IMMEDIATE` transaction. A recording failure throws.
  The log file is opened per event and never held open, so tests can delete temp dirs on
  Windows without `end()`.
- `store.ts`: `SessionStore` (create, get, list, forTask, events, logPathFor). Rows are
  validated with zod when read. `log_path` is stored relative to the storage directory (so the
  directory can move) and resolved to an absolute path in `SessionRecord.logPath`.

Other edits:
- `src/storage/migrations.ts`: appended a migration (index 8, `user_version` 9) that creates
  `sessions` and `session_events`, plus indexes on task, job, parent, status, created_at, and
  `session_events(type, at)`. `session_events.session_id` references `sessions(id)`.
  `sessions.task_id` has no foreign key, so a session can exist without a task row.
- `src/runners/types.ts`: added `session: SessionRecorder | null` to `RunContext`. When the
  session is set, `ask()` calls `syncMessages(req.chat.messages)` and `modelRequest(req)` before
  the gate request. It then calls `modelResponse(res)`, or `modelError(...)` with the error's
  attempts before rethrowing. The gate call sits in its own try block, so a recording failure
  after a successful response is not logged again as a model error.
- `src/core/executor.ts`: `session: null` in the `RunContext` literal. This is the only literal
  in `src/`; tests build none.
- `src/core/service.ts`: `readonly sessions: SessionStore`, constructed after `artifacts` with
  `(db, cfg.storageDir, now)`. Nothing needs closing.
- `src/admin/insights.ts`: `sessionsView` and `sessionDetail`, plus re-exported types.
- `src/index.ts`: exports the store, the recorder, the schemas, and their types.
- `tests/sessions.test.ts`: 13 tests.

## Final signatures (quote these)

```ts
// src/sessions/events.ts
export const SESSION_STATUSES = ["running", "completed", "failed", "interrupted", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type SessionEndStatus = Exclude<SessionStatus, "running">;
export const TOOL_SIDE_EFFECTS = ["none", "read", "edit", "command", "delegate", "brain", "external"] as const;
export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number];
export const SESSION_EVENT_TYPES = ["started", "message", "model_request", "model_response", "model_error", "tool_intent", "tool_outcome", "note", "workspace", "ended"] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
export const TOOL_OUTPUT_CAP_BYTES = 16 * 1024;
export interface WorkspaceRepo { alias: string; worktree: string; branch: string | null; baseCommit: string | null; head: string | null }
export interface SessionWorkspace { repos: WorkspaceRepo[] }
export type SessionEvent = { seq: number; at: number /* ms epoch */; type: SessionEventType; data: ... } // discriminated union on `type`
export type SessionEventOf<T extends SessionEventType>;   // Extract<SessionEvent, {type: T}>
export type SessionEventData<T extends SessionEventType>; // SessionEventOf<T>["data"]
export interface CorruptLine { line: number /* 1-based; 0 = log unreadable */; error: string; excerpt: string /* first 200 chars */ }
```

Event `data` shapes:
- `started`: `{ sessionId, taskId: string|null, jobId: string|null, parentSessionId: string|null, previousSessionId: string|null, role: RoleName, agentLabel, profile: string|null, tier: string|null }`
- `message`: `{ index: number, message: ChatMessage }`. To replay: `transcript[index] = message`
  and drop everything after `index`. `model_request.messageCount` gives the transcript length
  actually sent.
- `model_request`: `{ executionId, purpose, messageCount, maxTokens, temperature: number|null, tools: string[] /* names */, toolChoice: string|null, responseFormat: string|null /* type */ }`
- `model_response`: `{ requestId, endpointId, content: string|null, toolCalls: ChatToolCall[], finishReason: string|null, usage: NormalizedUsage, servedModel: string|null, servedProvider: string|null, attempts: GateAttempt[], estimatedInputTokens: number }`
- `model_error`: `{ executionId, message, code: string|null /* e.g. "gateway:rate_limited" */, status: number|null, attempts: GateAttempt[] }`
- `tool_intent`: `{ callId, name, args: unknown, sideEffect: ToolSideEffect, idempotent: boolean }`
- `tool_outcome`: `{ intentSeq, callId, name, ok: boolean, output: string /* <= 16 KB UTF-8 */, truncated: boolean }`
- `note`: `{ text: string, data?: unknown }`
- `workspace`: `SessionWorkspace`
- `ended`: `{ status: SessionEndStatus, stopReason: string }`

`session_events.name` holds the message role, the purpose, the endpoint id, the error code,
the tool name, or the end status, depending on the event type. `ok` is 1 or 0 for
`model_response`, `model_error`, and `tool_outcome`, and NULL for other events.

```ts
// src/sessions/recorder.ts
export interface ModelRequestInput { executionId: string; purpose: string; chat: Omit<ChatRequest, "model"> }
export interface ModelErrorInput { executionId: string; error: unknown; attempts?: GateAttempt[] }
export interface ToolIntentInput { callId: string; name: string; args: unknown; sideEffect: ToolSideEffect; idempotent?: boolean /* default false */ }
export interface ToolOutcomeInput { ok: boolean; output: string }

export class SessionRecorder {
  readonly id: string;
  readonly logPath: string;               // absolute
  get lastSeq(): number;
  get ended(): boolean;
  syncMessages(messages: ChatMessage[]): number;          // returns messages.length
  modelRequest(req: ModelRequestInput): number;           // seq; sessions.model_requests += 1
  modelResponse(res: GateResponse): number;               // seq
  modelError(input: ModelErrorInput): number;             // seq
  toolIntent(input: ToolIntentInput): number;             // seq (the intent seq); sessions.tool_calls += 1
  toolOutcome(intentSeq: number, input: ToolOutcomeInput): number; // throws if intentSeq has no open intent
  note(text: string, data?: unknown): number;
  setWorkspace(workspace: SessionWorkspace): number;      // also sets sessions.workspace_json
  end(status: SessionEndStatus, stopReason: string): number; // second call is a no-op returning the first ended seq
  /** @internal */ append<T extends SessionEventType>(type: T, data: SessionEventData<T>, idx: IndexUpdate): number;
}
```
Any append after `end()` throws `session <id> has ended`. Sequence numbers start at 1 (the
`started` event).

```ts
// src/sessions/store.ts
export const SESSIONS_DIR = "sessions";
export type CreateSessionInput = {
  taskId?: string | null; jobId?: string | null; parentSessionId?: string | null; previousSessionId?: string | null;
  role: RoleName; agentLabel: string /* min 1 */; profile?: ProfileName | null; tier?: TierName | null;
}; // validated by CreateSessionInputSchema (zod); invalid input throws
export interface SessionRecord {
  id: string; taskId: string | null; jobId: string | null; parentSessionId: string | null; previousSessionId: string | null;
  role: RoleName; agentLabel: string; profile: ProfileName | null; tier: TierName | null;
  status: SessionStatus; stopReason: string | null; logPath: string /* absolute */; lastSeq: number;
  modelRequests: number; toolCalls: number; workspace: SessionWorkspace | null;
  createdAt: number; updatedAt: number; endedAt: number | null; // ms epoch
}
export interface SessionListFilter { status?: SessionStatus | SessionStatus[]; taskId?: string; jobId?: string; parentSessionId?: string; limit?: number /* default 100, max 1000 */ }
export interface SessionEventsPage { sessionId: string; events: SessionEvent[]; corrupt: CorruptLine[]; hasMore: boolean; lastSeq: number }

export class SessionStore {
  constructor(db: Db, storageDir: string, now?: () => number);
  logPathFor(id: string): string;
  create(input: CreateSessionInput): SessionRecorder;   // inserts the row (status running), writes `started`
  get(id: string): SessionRecord | null;
  list(filter?: SessionListFilter): SessionRecord[];    // newest first
  forTask(taskId: string): SessionRecord[];             // oldest first
  events(id: string, opts?: { afterSeq?: number; limit?: number /* default 1000, max 10000 */ }): SessionEventsPage | null; // null = unknown session
}

// Switchyard
readonly sessions: SessionStore;

// RunContext (src/runners/types.ts)
session: SessionRecorder | null;
```

```ts
// src/admin/insights.ts (exported as `insights.*`)
export interface SessionView extends SessionRecord { taskLabel: string | null; durationMs: number }
export interface SessionDetail extends Omit<SessionEventsPage, "sessionId"> {
  session: SessionView;
  children: SessionView[];      // sessions whose parentSessionId is this one, oldest first
  taskSessions: SessionView[];  // forTask(session.taskId), oldest first; [] when no task
}
export function sessionsView(sy: Switchyard, filter?: SessionListFilter): SessionView[];
export function sessionDetail(sy: Switchyard, id: string, opts?: { afterSeq?: number; limit?: number }): SessionDetail | null;
// also re-exports types: SessionRecord, SessionListFilter, SessionEventsPage, SessionEvent, SessionStatus, CorruptLine
```

`src/index.ts` exports `SessionStore`, `CreateSessionInputSchema`, `SESSIONS_DIR`,
`SessionRecorder`, `SessionEventSchema`, `SessionStatusSchema`, `SessionWorkspaceSchema`,
`ToolSideEffectSchema`, `SESSION_STATUSES`, `SESSION_EVENT_TYPES`, `TOOL_SIDE_EFFECTS`, and
`TOOL_OUTPUT_CAP_BYTES`, plus every type listed above.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router): no output (clean).
- `npx vitest run tests/sessions.test.ts`: 1 file, 13 tests passed.
- `pnpm --filter switchyard-router build`: succeeded (`tsc -p tsconfig.build.json`).
- `pnpm -r typecheck`: `packages/router typecheck: Done` and `apps/panel typecheck: Done`.
- `npx vitest run` (packages/router): `Tests 109 passed (109)`, `Test Files 3 failed | 14
  passed (17)`. The 3 failed files are `evals/hidden/{add-duration,fix-range,rename-option}/*.test.mjs`.
  They are eval fixtures that import `../src/config.js`, which does not exist in this package.
  Vitest collects them because the package has no vitest config. They are tracked since
  569e71d and this change does not touch them. They fail at load time and contain no router
  tests.
- `npx vitest run tests`: `Test Files 14 passed (14)`, `Tests 109 passed (109)`. That is the 96
  existing tests plus the 13 new ones.

What the tests cover: create, every append type, and end; counters and `session_events` rows
(type, name, ok) match the log; list by status (single and array), task, job, parent, and
limit; `forTask` order; zod rejection of a bad role or an empty label; `syncMessages` logs each
message once, ignores in-place compaction of tool outputs, and logs again from the point where
the transcript was rewritten; the 16 KB tool-output cap; `toolOutcome` throws for a missing or
already closed intent; append after end throws and a second end is a no-op; paging with
`afterSeq`, `limit`, and `hasMore`; the raw JSONL is newline-terminated, every line validates,
and the log is readable after `close()` and through a new `Switchyard`; corrupt lines (bad
JSON, a schema violation, a torn final line) are skipped and reported with line numbers while
valid lines after them are still returned; a missing log is reported as line 0; `ask()` with a
session records message, request, and response; a gateway error records a `model_error` with
its code, status, and attempts and is rethrown; `ask()` without a session records nothing;
`sessionsView` and `sessionDetail` return task labels, children, task sessions, and paging.

## Not verified

- Recording on any real runner path: the executor still passes `session: null` (the
  s1-runners brief).
- Behaviour when the disk is full or the fsync fails. The code throws, but no test injects the
  failure.
- Performance of `events()` on very large logs. It reads the whole file on every call.
- The panel build. Only the panel typecheck ran.

## Open questions or contradictions found

- Status vocabulary: the decisions list `running -> completed | failed | interrupted |
  cancelled`, but `RunOutcome.state` also includes `budget_exhausted`. I kept the decided set,
  so s1-runners should map `budget_exhausted` to `failed` with stopReason
  `budget_exhausted` (or the supervisor can widen the enum, which needs a new migration
  because of the CHECK constraint).
- Batch runner: `ask(first, ...)` records the shared batch request only in the first item's
  session, if that context has one. s1-runners must decide how the other items' sessions see
  the request, for example a `note` with the request id, or recording into each session.
- OpenCode policy gateway: concurrent requests carrying different message arrays make
  `syncMessages` treat each switch as a rewrite and log messages again. This is correct but
  verbose. S2 may want a session per OpenCode conversation.
- `SessionRecorder.append` is public (marked `@internal`) because `SessionStore.create` writes
  the `started` event through it. Other callers should use the typed methods.
- There is no way yet to reattach a recorder to an existing session, for example after a
  restart. That belongs to S2.
