# Batch safety review

## Current State
Read-only review complete against pending diff in `D:/SwitchYardRouter/.claude/worktrees/harness-batch-usage`. No source changes, tests, provider calls, commits or live configuration access performed.

## Findings

1. **Medium: MCP batch schema rejects valid large output-page offsets.** `packages/router/src/harness/operation-registry.ts:18` takes the first schema for every duplicate argument name. `list_paths` contributes `offset` with maximum 1,000,000 (`repository-operations.ts:12`) before `read_output_page`, whose execution schema deliberately has no maximum (`output-pages.ts:15`). `task-tools.ts:85` installs this model schema as the SDK input validator. Reproduction: external MCP `batch` with one `read_output_page` item, valid scoped artifact reference and `offset: 1000001` is rejected by the SDK although the standalone operation accepts that offset. This breaks lossless batched continuation for large outputs. Requested correction: construct a genuinely permissive superset for colliding properties (preserve only shared constraints, or widen per property), retaining operation-specific validation at execution. This is a correctness blocker for the claim that the portable batch schema accepts existing valid operation arguments. Source-verified; reproduction not executed.

2. **Medium: native automatic coalescing raises actual read concurrency from four to sixteen.** `loop.ts:335-341` starts four tool calls; each `read_files` tool starts four independent file readers (`repository-operations.ts:21`). Reproduction: same model response contains four `read_files` calls with four files each; block/instrument RepoReader.readFile and count 16 active reads. Existing new test instruments single-file calls and therefore misses the multiplication. Explicit `batch` had the same nesting issue already (`operation-registry.ts:68`); the change introduces it to ordinary native same-turn calls. Guidance and workspace_info advertise four concurrent reads. Requested correction: shared task-level observation semaphore, or an explicit accurate separate tool-call/file-read limit with corresponding tests. Source-verified; reproduction not executed.

## Safety conclusions

- Native prefetch only groups consecutive allowlisted repository reads. Edit, command, terminal, operation cancellation and approval/wait calls stop a group. Reads after an edit are not started before it.
- `Promise.allSettled` waits for every started native read before propagating cancellation or an uncaught journal fault. The next iteration rechecks authority; subsequent edits are not started after cancellation/lease loss.
- Per-invocation shallow environment copies prevent toolInvocationId races while retaining shared edit sets, evidence maps and contexts. No changed tool inspected requires a scalar mutation to persist on the outer environment.
- Each concurrent call retains its own tool intent/outcome ID. Session resume reconstructs pending calls by IDs and intent sequences rather than requiring outcomes to arrive in intent order; no new replay defect identified by source inspection.
- Flattened apply_edits advertises a permissive model shape but strict union validation remains in executeOperation. Missing action/hash does not reach mutation execution.
- run_checks now stops at waiting_approval even when stop_on_failure is false, avoiding requests for later checks before resolving the current approval. Commands remain serial.

## Validation limits
Reviewed required implementation diffs, focused added tests, and narrowly necessary journal, operation lifecycle, session resume, output-page and RepoReader code. No runtime checks were run, as requested. Existing batch implementation still uses Promise.all (rather than allSettled) on grouped children; this predates the diff and is not a new-regression finding here. Supervisor should separately decide whether hardening that existing path belongs in this work unit.

## Resolution review
Re-reviewed the subsequent registry/guidance/test hunks only; no tests run.

- Finding 1 is resolved by source inspection. Duplicate argument fields now use a Zod union of every operation-specific schema. A supplied offset above 1,000,000 fails the list_paths branch but succeeds against OutputPageArgs, so MCP input validation preserves the requested value. The common portable type metadata changes JSON Schema presentation, not the Zod execution parser. Existing per-operation `def.args.parse(item.args)` still rejects the same large offset when operation=list_paths. The new actual-MCP test checks both successful tail content at offset 1,000,005 and rejected list_paths using that offset. Supervisor must inspect its execution result independently.
- Finding 2 is resolved as an explicitly documented concurrency policy, not a new global semaphore. Both batch description and injected harness guidance now specify four concurrent operation invocations with up to four file workers per read_files invocation. That accurately describes the possible sixteen simultaneous physical file reads. workspace_info's legacy read_concurrency:4 field remains terse, but the adjacent injected/tool descriptions supply its operation-level interpretation. No remaining correctness blocker from this finding.

No new blocking issue identified in these revised hunks. Runtime verification remains the supervisor's responsibility.
