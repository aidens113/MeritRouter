# Harness batching usage correction

Status: Done (worker claim; supervisor integration review required)
Date: 2026-10-23
Isolation: `feat/harness-batch-usage` worktree, original repository HEAD

## Confirmed causes

- `apply_edits.edits.items` was a discriminated union. Clients projecting only type,
  properties, required, items and enum lost every action-specific union field,
  including the required action discriminator. A malformed missing-action edit is
  reproducibly rejected before effects.
- `read_files.files.items` had the same string/object union portability problem.
- `batch.items.args` was an untyped record rather than named operation arguments.
- The native model loop awaited every emitted tool call serially, even when several
  independent repository reads arrived in one response.
- Native check instructions explicitly recommended single `run_check` invocations;
  task-scoped MCP startup omitted the shared v2 batching guidance.
- `run_checks` reported pending approval as failed and could advance to later commands
  with stop_on_failure=false before that approval resolved.

## Changes

Operation definitions now separate portable modelArgs from strict execution args.
Flat edit items advertise required action/path plus all conditional fields; runtime
validation still requires action-specific hashes/content/text. Read item metadata
advertises typed object refs, preserving legacy string acceptance in SDK parsing.
Batch envelopes advertise operation names and a typed superset of nested arguments,
then validate each exact operation before effects. Shared argument names accept the
union of their operation-specific schemas; independent review caught and corrected
the first draft incorrectly inheriting listing offset max1M for artifact paging.
Native and task-scoped MCP both
use the portable descriptions. Concrete examples cover file/edit/check grouping;
conflicting single-check guidance was corrected.

The native loop coalesces consecutive known repository-read calls from the same model
response, at most four tool invocations concurrently. Each call has its own environment,
invocation ID, journal intent/outcome and original ordered tool response. Started reads
quiesce before cancellation/crash propagates. Commands, mutations, approval operations,
waits and terminal tools remain barriers. Explicit batch/read_files retain their own
existing concurrency limits: nested read_files can each run four file workers, so the
limit is per tool invocation rather than a new aggregate filesystem semaphore.

Grouped checks remain serial and individually authorized; stop_on_failure=false
collects independent failed checks, while pending approval always stops further commands
and remains waiting_approval. No command parallelism or approval bypass was added.

## Validation

- Isolated offline dependency install reused219 packages, downloaded0; ignore-scripts
  left SQLite native binding missing. Copied the existing same-version compiled binding
  from root node_modules into isolated node_modules; no root source/dependencies changed.
- Router TypeScript check passed after correcting three local type errors.
- Harness v2 and repeat suites passed33/33 after replacing a timing-sensitive new
  concurrency assertion with a deterministic four-start barrier. Covers projected schema,
  missing discriminator/hash rejection, independent read failure, serial grouped checks,
  pending approval, same-turn concurrency/IDs/order and cancellation quiescence.
- Actual MCP `external-task-tools`9/9 passed, including nested typed schema inspection,
  real batched reads, legacy string file arguments, command timeout quiescence and
  expired/denied approvals. The initial six-file attempt returned43pass/30dependency
  failures because session/native tests started before the SQLite binding was restored.
- After restoring that isolated dependency, `pnpm exec vitest run
  tests/session-faults.test.ts tests/session-recording.test.ts tests/native.test.ts
  --maxWorkers=1 --minWorkers=1` passed31/31, exit0,140.65s. Covers real journal ordering,
  read replay, accepted-terminal recovery, applied/absent edit recovery, delegation
  idempotency, per-response commit attribution and supervisor resume.
- Independent reviewer correction: final actual MCP/harness rerun26/26 passed,
  exit0,29.43s. Real MCP proves artifact-page offsets above1M work while the same
  listing offset is still refused by that operation's original validator. Final router
  TypeScript check passed. Descriptions now explicitly distinguish operation and
  nested file-worker concurrency.
- Combined focused coverage:74/74 passed across the six files after environment
  correction; this is the observed harness/MCP pass plus the three-file rerun, not a
  fabricated all-green exit for the initial six-file command. `git diff --check` passed.

## Limits

This establishes correct schema advertisement and execution of emitted batches. It
cannot promise that every provider/model will choose to group future unknown work.
Separate MCP requests retain the bridge's serial queue; callers should use batch or
read_files. No live model/provider calls, private session transcripts, live config,
runtime user data, commits or pushes were used.
