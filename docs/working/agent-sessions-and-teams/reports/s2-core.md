# Report: s2-core

Worker report for "Brief: s2-core" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).

## Outcome

Done. The session store can now resume a session. It has `reopen`, `transcript`,
`pendingIntents`, `markDeadRunning`, and a `planResume` convenience method. A new pure module,
`src/sessions/resume.ts` (`planResume`, `replayTranscript`, `pendingIntentsFrom`, `RESUME_TEXT`,
`editRecoveryMessage`), implements the "S2 and R1 decisions" rules. The log has a new `resumed`
event type, recorded with `recorder.resumed(summary, actions, detail)`. `pnpm -r typecheck`
passes, and `npx vitest run tests` passes 134 of 134 tests, 12 of them new.

## What changed and why

- `src/sessions/events.ts`
  - Added `"resumed"` to `SESSION_EVENT_TYPES` and to `SessionEventSchema`.
  - Added `RecoverEditsPolicySchema`, `ResumeToolRefSchema`, `ResumeActionSchema` (a
    discriminated union on `kind`), and `ResumedDataSchema`, with their inferred types.
- `src/sessions/recorder.ts`
  - Index updates are now derived from each event by the exported function
    `indexUpdateFor(event)`. They are written by the exported function `writeIndex(...)`.
  - `append(type, data)` lost its third argument. Every typed method now goes through the
    derived update. Only `store.ts` called `append` directly.
  - `last_seq` is updated with `MAX(last_seq, ?)`.
  - The constructor takes an optional `RecorderRestore` (`messages`, `openIntents`), so a
    reopened recorder:
    - does not log the existing transcript again;
    - can still close intents that were open before the crash.
  - Added `resumed()`. It closes the intents it resolves in memory, so a later `toolOutcome`
    for one of them throws.
- `src/sessions/store.ts`
  - Added `reopen`, `markDeadRunning`, `transcript`, `pendingIntents`, `planResume`, and
    `PROCESS_DIED`.
  - Log parsing moved into a module-level `parseLog`. `events()` keeps its contract: paging,
    `hasMore`, and corrupt lines reported.
  - The private `reattach` runs before any write to an existing log. It:
    - terminates a torn final line, so the next append does not join it and become corrupt
      itself;
    - backfills `session_events` rows, counters, and status for log lines that were fsynced but
      never indexed (a crash between the fsync and the SQLite transaction).
- `src/sessions/resume.ts` (new): the pure replay and planning functions, described below.
- `tests/session-resume.test.ts` (new): 12 tests.

## Final signatures (quote these)

```ts
// src/sessions/events.ts (additions)
export const SESSION_EVENT_TYPES = [..., "ended", "resumed"] as const;
export const RecoverEditsPolicySchema = z.enum(["commit", "reset"]);
export type RecoverEditsPolicy = "commit" | "reset";
export interface ResumeToolRef {            // ResumeToolRefSchema
  intentSeq: number;                        // seq of the tool_intent with no outcome
  callId: string;
  name: string;
  args?: unknown;                           // as journaled (parsed args, or the raw string)
  messageIndex: number | null;              // index in ResumePlan.messages of the tool message to fill; null = no slot
}
export type ResumeAction =                  // ResumeActionSchema, discriminated on `kind`
  | (ResumeToolRef & { kind: "rerun_tool"; sideEffect: "delegate" | "command"; result?: string })
  | { kind: "reconcile_edits"; policy: RecoverEditsPolicy; repos: WorkspaceRepo[];
      calls: ResumeToolRef[];               // edit calls with no outcome (their messages hold a placeholder)
      completedCallIds: string[];           // edit calls that finished after the last recorded head (uncommitted; real outputs kept)
      result?: string }
  | (ResumeToolRef & { kind: "report_external"; result?: string });
// "resumed" event data (ResumedDataSchema):
//   { summary: string; actions: ResumeAction[]; resolvedIntentSeqs: number[]; droppedRequestSeqs: number[] }
```

```ts
// src/sessions/resume.ts (new, pure)
export interface PendingIntent { seq: number; at: number; callId: string; name: string; args: unknown; sideEffect: ToolSideEffect; idempotent: boolean }
export interface TranscriptReplay { messages: ChatMessage[]; warnings: string[] }
export const RESUME_TEXT: {
  notRun: "interrupted before this call ran; call it again if it is still needed";
  retry: "interrupted; call again";
  recovering: "interrupted; recovering";   // placeholder the caller replaces with an action's result
  commandUnknown: "interrupted; outcome unknown: the command may or may not have run. Check its effects before running it again.";
  brainUnknown: "interrupted; outcome unknown; check the brain before repeating";
  editUnknown: "interrupted; outcome unknown and no workspace is recorded to reconcile; re-read the files before editing again";
};
export function replayTranscript(events: readonly SessionEvent[]): TranscriptReplay;
export function pendingIntentsFrom(events: readonly SessionEvent[]): PendingIntent[];   // oldest first
export interface PlanResumeOptions { recoverEdits?: RecoverEditsPolicy /* default "commit" */; reason?: string /* default: last ended stopReason */ }
export interface ResumePlan {
  messages: ChatMessage[];
  actions: ResumeAction[];
  summary: string;
  resolvedIntentSeqs: number[];
  droppedRequestSeqs: number[];
  workspace: SessionWorkspace | null;   // last `workspace` event
  reason: string | null;
  warnings: string[];
}
export function planResume(events: readonly SessionEvent[], opts?: PlanResumeOptions): ResumePlan;
export function editRecoveryMessage(policy: RecoverEditsPolicy, files: readonly string[]): string;
```

```ts
// src/sessions/recorder.ts (additions / changes)
export interface IndexUpdate { name: string | null; ok: boolean | null; requests: number; tools: number; workspace: SessionWorkspace | null; ended: { status: SessionEndStatus; stopReason: string } | null }
export function indexUpdateFor(event: SessionEvent): IndexUpdate;
export function writeIndex(db: Db, sessionId: string, seq: number, type: SessionEventType, at: number, idx: IndexUpdate): void;
export interface RecorderRestore { messages: ChatMessage[]; openIntents: Array<{ seq: number; callId: string; name: string }> }
class SessionRecorder {
  constructor(id: string, db: Db, logPath: string, now: () => number, lastSeq?: number, restore?: RecorderRestore);
  resumed(summary: string, actions: ResumeAction[], detail?: { resolvedIntentSeqs?: number[]; droppedRequestSeqs?: number[] }): number; // seq
  /** @internal */ append<T extends SessionEventType>(type: T, data: SessionEventData<T>): number; // 3rd arg removed
}
```

```ts
// src/sessions/store.ts (additions)
export const PROCESS_DIED = "process_died";
export interface ReopenOptions { from?: SessionEndStatus[] /* default ["interrupted"] */ }
class SessionStore {
  reopen(id: string, opts?: ReopenOptions): SessionRecorder;
  markDeadRunning(isLeaseLive: (session: SessionRecord) => boolean, stopReason?: string /* "process_died" */): SessionRecord[];
  transcript(id: string): ChatMessage[] | null;          // null = unknown session
  pendingIntents(id: string): PendingIntent[] | null;
  planResume(id: string, opts?: PlanResumeOptions): ResumePlan | null;  // whole log; corrupt lines appended to warnings
}
```

Semantics:
- `reopen(id)`:
  - throws `unknown session <id>`, or `session <id> is <status>; only interrupted sessions can
    be reopened`;
  - runs `reattach` (torn line, index backfill) first;
  - then, in one `BEGIN IMMEDIATE`, sets `status='running'` and `stop_reason`/`ended_at` to
    NULL `WHERE status IN (from)`, so only one process can claim the session;
  - then writes a `note` "reopened" `{previousStatus, previousStopReason}`;
  - the returned recorder continues from `max(index last_seq, highest log seq)`. The counters
    `model_requests` and `tool_calls` are kept and keep counting.
- `markDeadRunning`:
  - calls `isLeaseLive` for every `running` session, oldest first;
  - for each one that returns false, appends `ended {interrupted, process_died}` to the log
    (after `reattach`), which also sets the row;
  - returns the sessions it ended. Running it again changes nothing.
- Pending intent (`pendingIntents`): a `tool_intent` with none of the following:
  - a `tool_outcome`;
  - a later `tool_intent` with the same `callId` (a re-run supersedes the interrupted call);
  - a `resumed` event listing it in `resolvedIntentSeqs`.
- `transcript`: `transcript[index] = message`, dropping everything after `index`. A gap left
  by a corrupt line is closed up, with a warning in `replayTranscript`.

## How a caller uses `planResume` (for s2-exec)

1. At recovery, call `sy.sessions.markDeadRunning(s => <task lease of s.taskId is live>)`.
2. For a task whose latest session is `interrupted` and whose role is resumable:
   - `const rec = sy.sessions.reopen(id)`;
   - `const plan = sy.sessions.planResume(id, { recoverEdits: cfg.sessions.recover_edits })`.
   - Reopen first, so a second process cannot plan the same session. Planning reads the log,
     so it sees the "reopened" note, which is harmless.
   - If `plan.messages.length === 0`, nothing was logged: start the run fresh.
3. Handle each action. Write the text the model should see into
   `plan.messages[messageIndex]` (a `{role:"tool", tool_call_id: callId, content}` message;
   skip this when `messageIndex` is null), and keep it as the action's `result`.
   - `rerun_tool`: run the tool again with `args`, journaled as a new
     `rec.toolIntent({callId, name, args, sideEffect})` and `toolOutcome`. Use the same
     `callId`, so a crash during recovery re-plans from the re-run's output instead of running
     it a third time. The tool message gets the tool's output.
     - `delegate` is idempotent by label;
     - `command` appears only when the intent was marked `idempotent`.
   - `reconcile_edits`: for each repo, compare the worktree with `repo.head` (the last
     committed head).
     - `commit` policy: commit the difference as "recovered" under the session's identity, then
       record the new head (`WorkspacePointer.setHead`, which writes a `workspace` event).
     - `reset` policy: reset to `head`.
     - Then give every `calls[i].messageIndex` the text
       `editRecoveryMessage(policy, files)`.
     - `completedCallIds` lists edits that finished but were never committed. Their tool
       messages are real outputs. With `reset`, say in the notice that those changes were
       reverted.
   - `report_external` (`ask_user`): look up the stored question and answer state and put it in
     the tool message.
4. Call `rec.resumed(plan.summary, plan.actions.map(a => ({...a, result})), plan)`. Pass the
   plan as `detail`: it carries `resolvedIntentSeqs` and `droppedRequestSeqs`.
5. Continue the loop with `[...plan.messages, { role: "user", content: plan.summary /* plus
   any runner-specific notice */ }]`, and set `ctx.session = rec`. The loop's next
   `syncMessages` logs only the new messages: the reconstructed assistant message, the tool
   messages, and the notice.

What the plan already handles:
- The assistant message of a response received but not yet logged is added back.
- A tool call whose outcome was recorded gets its recorded output, with a truncation note if
  the output exceeded 16 KB.
- An orphaned call (no intent) gets `RESUME_TEXT.notRun`.
- `none` and `read` get `retry`, a non-idempotent `command` gets `commandUnknown`, and `brain`
  gets `brainUnknown`.
- An edit with no recorded workspace gets `editUnknown` and a warning.
- A `model_request` with no response or error since the last resume is dropped
  (`droppedRequestSeqs`) and mentioned in the summary.
- A clean interruption (capacity deferral, shutdown between turns) gives "... Nothing was in
  flight. Continue from here."

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router): no output.
- `npx vitest run tests/session-resume.test.ts`: the first run had 5 failures because the
  tests used role `"coder"`, which is not a `RoleName`. After switching to `"implementer"`:
  `Tests 12 passed (12)`.
- `pnpm -r typecheck` (from D:\sy-wt\s2): `packages/router typecheck: Done`, `apps/panel
  typecheck: Done`.
- `npx vitest run tests` (packages/router): `Test Files 17 passed (17)`, `Tests 134 passed
  (134)`. That is the 122 existing tests plus 12 new ones.

What the tests cover:
- reopen:
  - seq and counter continuity, the "reopened" note, and the cleared status, stop reason, and
    end time;
  - `syncMessages` after a reopen logs only new messages;
  - an open intent can still be closed after a reopen;
  - index rows match the log;
  - the reopen fails on a running, completed, or unknown session, and `from: ["completed"]`
    allows it;
- a torn final line plus a durable but unindexed line: reopen terminates the torn line,
  backfills the index, and continues the seq;
- `markDeadRunning`: the predicate is called for running sessions only, a dead session gets an
  `ended` event in its log, and a second call changes nothing;
- transcript replacement semantics, and null for an unknown id;
- `planResume`:
  - every side-effect class (none, read, edit, delegate, idempotent command, non-idempotent
    command, brain, external) plus an orphaned call and a completed but unlogged outcome, with
    exact messages, actions, `messageIndex`, `resolvedIntentSeqs`, and summary;
  - the `reset` policy;
  - an edit with no workspace;
  - completed but uncommitted edits (`completedCallIds`);
  - a lost model request;
  - a capacity deferral with nothing in flight;
  - a pending intent with no transcript slot (`messageIndex: null`);
- the round trip:
  - a crash during recovery, after re-running the delegation: the re-run supersedes the
    intent, and the second plan uses its output and does not run it a third time;
  - `resumed` is written and indexed;
  - `pendingIntents` becomes empty, and a late `toolOutcome` throws;
  - the caller's `syncMessages` logs the plan's messages, and a later crash plans nothing.
- Action `result` values are stored in the `resumed` event, and `editRecoveryMessage` produces
  the expected texts.

## Not verified

- No runner, executor, or real worktree uses this yet; that is s2-exec's work. `reconcile_edits`
  was tested only as a plan, not against git.
- The `pnpm -r build` / dist rebuild was not run, so the panel was not checked against the new
  `"resumed"` type. See the first open question.
- Performance on large logs: `transcript`, `pendingIntents`, `planResume`, `reopen`, and
  `events` each read and parse the whole file.
- Two processes racing on `reopen`: the conditional UPDATE is the guard, but no test runs two
  processes.

## Open questions or contradictions found

1. **The panel will fail typecheck once the router `dist` is rebuilt.** In
   `apps/panel/components/session-timeline.tsx`, line 13 declares
   `const TYPE_LABEL: Record<SessionEvent["type"], string>`, which is now missing `resumed`.
   The panel's switches also have no `"resumed"` case. It typechecks today only because the
   panel reads the stale `dist` types. Someone who owns `apps/panel/**` (the supervisor, or
   s2-surface) needs to add a label and a rendering for it before s2-exec runs
   `pnpm -r build && pnpm -r typecheck`, or s2-exec will see a failure outside its files.
2. **`src/index.ts` (not mine) does not export the new API yet.** Suggested additions:
   - from `./sessions/resume.js`: `planResume`, `replayTranscript`, `pendingIntentsFrom`,
     `editRecoveryMessage`, `RESUME_TEXT`, and the types `PendingIntent`, `PlanResumeOptions`,
     `ResumePlan`, `TranscriptReplay`;
   - from `./sessions/events.js`: `ResumeActionSchema`, `RecoverEditsPolicySchema`, and the
     types `ResumeAction`, `ResumeToolRef`, `RecoverEditsPolicy`;
   - from `./sessions/store.js`: `PROCESS_DIED` and the type `ReopenOptions`.
3. A terminal tool (for example `submit`, journaled as `none`) whose outcome was "accepted"
   before the crash is not treated specially. The plan restores its recorded output, and the
   loop would ask the model again. s2-exec may want to detect an accepted terminal call in the
   tail and finish without another request.
4. `RESUME_TEXT.recovering` placeholders stay in the transcript if the caller skips an action.
   That is still a valid transcript, but the caller should always replace them.
5. The `sessions.recover_edits` configuration key named in the decisions does not exist yet. It
   is outside `src/sessions/**`, so `planResume` takes the policy as an option.
