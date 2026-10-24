# Harness v2 replacement design and implementation brief

Status: Proposed; source not modified
Owner: harness-redesign worker
Date: 2026-10-23

## Current State: verified implementation

`src/harness/tools.ts` combines reading, edits, shell checks and brain tools, building JSON schemas manually and coercing arguments. `runners/coding/task-tools.ts` duplicates selected schemas. Use one zod contract for runtime validation and generated schemas.

Repository reads require an explicit alias and have no deliberate batch interface. `list_files` with empty directory works, but `.` reaches `context/repo-reader.ts:normalizeRelPath`, whose reserved trailing-dot check rejects it before its final root conversion. Root-directory normalization must be separate from file-target validation. Missing aliases cannot silently select among multiple repositories.

Read outputs cap at 16,000 characters with no cursor or complete output artifact; individual files cap at 512 KiB. The agent loop supports multiple calls in a response but executes them sequentially. This is not bounded batch scheduling with independent item outcomes.

Useful defenses already exist: CRLF normalization, path argument aliases for editing, exact-replacement ambiguity rejection, symlink/hardlink escape guards, config-file protection, allowed-path enforcement, source identity, command approval, request budgets, repeat protection and durable intent/outcome journaling. Retain those properties.

`runners/coding/process.ts` already has process timeouts, abort signals, hidden Windows launches, tree termination and capped streams. The missing piece is a uniform model-visible operation lifecycle and configurable per-call timeout, not absence of all process controls. `worker-actions.ts` caps command timeout at 300,000 ms, binds lease/source identity and reloads security policy. Shell wrappers cannot bypass that policy.

`sessions/events.ts` classifies side effects for recovery and caps tool logs at 16 KiB. Composite calls require child-level journal records: one batch intent cannot safely recover mixed effects. Native coding commits per response; external task bridge exposes a narrower task-only capability set and must remain task-scoped.

## Proposed replacement contract

Each operation owns one zod argument/result schema, generated tool definition, role availability, authority class, side effect, replay rules, deadline and handler. Native and MCP adapters consume the same registry. Validate persisted envelopes too. Result fields: operation ID, status, duration, revision/workspace identity, data, diagnostics, artifact and continuation references. Statuses: succeeded, failed, denied, waiting_approval, timed_out, cancelled, unknown_effect. A nonzero check exit is structured execution evidence rather than an opaque transport error.

| Tool | Contract |
| --- | --- |
| `workspace_info` | OS, aliases/default repository, writable paths, base/current revision, recipes, dependencies, permissions, deadlines and remaining limits; also injected at startup. |
| `read_files` | Ordered array of paths/ranges; independent per-file outcomes, hashes, numbered lines and bounded aggregate output. |
| `list_paths`, `search_text` | Root defaults, glob, literal/regex modes, paging and complete artifact. No matches is successful. |
| `apply_edits` | Expected hashes, explicit create/replace/delete, grouped preflight, preserved line endings and durable per-file reconciliation. |
| `git_status`, `git_diff` | Typed read-only wrappers; no worker commit/push/reset capabilities. |
| `run_recipe`, `run_checks` | Declared IDs resolved to executable/argv/cwd/environment, revision-bound evidence and explicit permission. |
| `batch` | Stable child IDs and dependency references, bounded independent reads, ordered effects, no nested batches. |
| `operation_status`, `cancel_operation` | Caller-owned long operation state, source revision, approval and confirmed process termination. |

Normalize `.`/`./`/empty only for root-directory operations; normalize Windows separators. Resolve an omitted repository only to explicit task default or sole granted alias. Accept documented synonymous field names only if unambiguous; conflicting synonyms fail. Return exact corrected examples for invalid calls. Do not guess malformed JSON, dangerous shell commands or ambiguous write targets.

Exact replacement retains strict matching; a mismatch returns nearby context/hash and counts, never applies a guessed fuzzy edit. Full overwrite requires explicit replacement intent and old hash. Large deletions and suspicious placeholders trigger review diagnostics; heuristics cannot prove semantic correctness.

## Batch execution and large output

Initial configurable proposal: 64 operations per batch, four concurrent reads, 128 KiB aggregate inline output and 32 KiB per item, further reduced to available model context. These are engineering proposals, not provider facts. Stream complete output into scoped artifacts and return a manifest with counts, truncation and stable cursors. Fair-share inline allocation prevents one file starving others. Reading 50 files should take one model request/tool operation when output fits; unlimited files must not imply unlimited context or heap use.

Independent reads run concurrently. Mutations default sequential; declared recipes may parallelize only with known-safe resource groups. Preflight every path/permission/hash before grouped edits. Do not falsely advertise cross-file filesystem atomicity: interruption can leave partial effects, all precisely recorded. Retry only proven nonexecuted/idempotent work. Each child rechecks authority, has a deadline and intent/outcome record. Batching does not bypass check-run counts, approvals or budgets. Cache only immutable reads or invalidate on relevant edits, including reader metadata.

## Timeouts, processes and approvals

Every operation accepts `timeout_ms`, default 30,000 ms, bounded by trusted configuration (proposed initial ceiling 300,000 ms). Effective deadline is minimum of selected, task and parent deadlines. Build/install recipes may specify 120,000–300,000 ms defaults. Services use readiness deadlines and managed lifetime, not infinite command calls. Models can adjust within granted caps; exceeding authority files an explicit request. Approval-wait duration and execution duration are separate, each bounded by task deadline.

Do not implement cancellation as Promise.race alone: it can return while effects continue. Use abortable reads, authority checks immediately before effects and confirmed process-tree close. Hold write/resource leases until cessation is confirmed or report unresolved ownership. Platform launchers must safely handle Windows npm/pnpm `.cmd` and paths with spaces without exposing model shell interpolation.

Recipe executable/argv is resolved from trusted project setup and explicit specification authority. Package scripts execute arbitrary code; a familiar wrapper does not make them sandboxed. Workers propose missing recipes, supervisors authorize only within granted policy. Preserve human-only outside-repository authority when configured. Shell fallback is restricted and clearly reported, never the default discovery method.

## Prompt and progress policy

Startup injects environment facts, tool examples, granted recipes, spec IDs and completion gate. Encourage batching independent observation and grouped surgical edits. Replace the current half-budget 'write now' heuristic with stage-aware progress: planning can produce approved specification artifacts, coding must produce implementation/check progress. Identical malformed calls get actionable corrections then escalation. Fresh check/state observations remain valid; uncertain commands never auto-repeat. Long-running operations and waits do not consume repeated model polling turns.

## Executable work units and ownership

These units are serial for harness ownership; shared integrations require explicit scheduled ownership. No catch-all files.

1. Add `src/harness/operation-contract.ts`, `operation-registry.ts`, `operation-dispatch.ts`; tests `tests/harness-operation-contract.test.ts`. Freeze schema/version/recipe interfaces first.
2. Add `src/harness/repository-operations.ts`, `output-pages.ts`; adapt `src/context/repo-reader.ts` for directory normalization, abort and paging; tests `harness-repository-operations.test.ts`, `harness-batch.test.ts`.
3. Add `src/harness/edit-operations.ts`; migrate containment from `tools.ts` unchanged in guarantees; tests `harness-edit-operations.test.ts` with revision conflicts and crash cases.
4. Add `src/harness/recipe-operations.ts`, `operation-lifecycle.ts`; change `runners/coding/process.ts`, `harness/worker-actions.ts`, `worker-action-tools.ts`; tests `harness-operation-lifecycle.test.ts`, extend `coding.test.ts`, `external-task-tools.test.ts`. Coordinate recipe/config/Lab schema ownership; never duplicate recipe truth.
5. Change `harness/journal.ts`, `resume.ts`, `repeat-policy.ts`, `loop.ts`, `sessions/events.ts` and recorder/replay consumers under one integration brief. Extend `session-faults.test.ts`, `session-resume.test.ts`, `harness-repeat-policy.test.ts`. Version optional events/fields so historical logs remain readable. Append a migration only if new persistence requires one.
6. Change `runners/coding/native.ts`, `runners/coding/task-tools.ts`, legacy `harness/tools.ts` facade and supervisor/read-only runner import sites in a serial integration unit. Publish operations/setup docs and versioned migration instructions. Config owner supplies validated caps; memory owner supplies registry operations; supervisor owner supplies spec-stage constraints and receipt requirements.

Use versioned v1/v2 tool surfaces. Existing sessions remain pinned to their original contract; v2 becomes default only after gates pass. Retain historical readers and a temporary rollback flag, then remove duplicated live implementations. Do not rewrite Gate, admission or brain storage merely to replace tools.

## Required acceptance and verification

- Valid fixtures: root `.`, `./`, empty directory; Windows separators/spaces/unicode; implicit sole/default alias. Ambiguous aliases fail with choices. All path escape, symlink/hardlink and config-write fixtures stay denied.
- One call reads 50 small files with ordered complete output. One missing file preserves 49 successes. Oversize 100-file batch yields bounded manifest/artifact/pages with lossless reassembly. Test output bytes/tokens and cancellation under load.
- Spawn a process with child and delayed write, timeout/cancel it, confirm no delayed effect after terminal stop. Native Windows and POSIX CI. Ownership cannot release before confirmed termination.
- Fault injection before intent, after every child effect and before outcome: no duplicate commands or writes; uncertain effects remain explicit. Cancel/stale lease during approval and mid-batch prevents remaining effects.
- Authorized check -> dependency install -> check works; uncertain command never repeats automatically; denied recipes/timeout extensions never execute. Cumulative check limits cannot be bypassed through batches.
- Native/MCP schema parity for granted tools. Historical sessions still read/resume; active v1 contract never changes mid-run. Preserve existing containment, bridge, repeat and session tests.
- Deterministic replay of trial root-list, alias, quoting and unavailable-check errors: zero avoidable safe-normalization failures; denied operations remain denied. No provider spend needed for this fixture gate.
- Authorized isolated live benchmark later: same spec/model/environment across baseline and v2, repeated runs; measure phase requests, tool mistakes, tokens, latency and integrated usability. Proposed target at least 50% fewer avoidable recovery turns; claim no savings until measured.
- Full repository typecheck, built-router tests, recursive build; panel runtime/screenshot validation if operation views change. Product acceptance must include actual user flows, never build-only success.

## Return contract

Changed only this report. Read implementation and relevant test contracts; no source edits, tests, provider requests, panel operation or commits performed. Numerical defaults and targets are proposals. Supervisor must integrate with hierarchy, budget, memory and spec-driven acceptance before dispatching source implementation.
