# Harness v2 implementation report
Status: Implemented; awaiting FINAL integration verification
Owner: harness-v2 implementation worker

## Current State
H1–H6 implementation is integrated into native coding and the task-scoped MCP bridge. The shared Zod registry exposes workspace facts, 64-item batches, four-way multi-file reads, paged lists/search/output, hash-guarded grouped edits, read-only Git wrappers, declared check recipes, check batches and task-owned operation status/cancellation. Legacy tool aliases remain for historical transcripts and compatibility; resumed native v1 sessions do not acquire v2 tools.

## Milestones and evidence
- H1: one operation registry generates native JSON schema and MCP Zod registration. Structured statuses distinguish operation failure from invocation completion. Loop/MCP/resume adapters preserve unsuccessful outcomes; observation comparison ignores transport identity/timing.
- H2: sole/default aliases, harmless directory roots and Windows separators work without weakening file-target validation. Multi-file outcomes remain independent; large output is preserved as scoped artifacts with lossless pages. Git readers accept AbortSignal; repository list/search return continuation offsets.
- H3: grouped edits preflight all targets/permissions/hash/matches before first effect. Each file rechecks captured lease and path containment immediately before mutation. Existing symlink/hardlink/config/allowedPaths guards remain authoritative. Full replacement requires explicit intent/hash; omission placeholders fail.
- H4: run_recipe/run_checks resolve only existing trusted task declarations, retaining human/parent approval and cumulative check limits. Requested deadlines default to 30s and cap at 300s/task/check deadlines. Cancellation awaits effect completion rather than Promise.race. Process close now waits tree termination; POSIX teardown no longer stops after parent exit while descendants may survive.
- H5: every batch child/file/check has intent/outcome journaling. Fault injection propagates as real interruption; unknown commands are not blindly retried. Existing session event schema remains backward-compatible; operation summaries use existing validated note events and are recoverable from the owning session log. Read evidence restores across resumed v2 transcripts.
- H6: native coding defaults offer v2 and inject startup OS/alias/base/scope/recipe/deadline facts. External bridge uses the same registry without writable workspace capability; batched edits remain unavailable. Supervisor integration supplied to FINAL supervisor via harnessV2Tools(env)/harnessV2StartupContext(env).

## Validation observed
- New harness-v2 suite:9/9 passed (50-file49-success mixed outcome, root/Windows normalization, ambiguity, group preflight/CAS/CRLF/omission rejection, child journal/dependency, lossless output pages, crash stop, timeout quiescence/lease loss, real process delayed-write negative).
- Combined harness-v2/external-task-tools/harness-repeat-policy:29/29 passed.
- Focused TypeScript semantic/syntactic diagnostics for owned new/adapted harness/native/bridge/reader/test files: no diagnostics. This is not a repository-wide typecheck.
- Additional native coding/session resume/session fault regression run in progress.

## Limits and pending verification
No live provider calls or commits. Full cross-platform process proof still requires Linux execution; this host verifies Windows. Recipe wrappers deliberately do not invent/install unauthorized setup recipes or replace existing approval authority. Real hydrated browser/service containment belongs to the separate runtime phase. Repository-wide checks deferred to FINAL supervisor after parallel edits finish. Further focused tests are being added for paging, durable status and revocation.

## Final worker receipt
- Latest combined gate:49/49 passed across harness-v2(13), external-task-tools(8), worker-containment(14), harness-repeat-policy(14).
- Native coding3/3 and session-resume12/12 passed. Session-faults9/10 passed; supervisor test at292 expects old automatic acceptanceStatus=met but now receives not_verified with unchanged supervisor_completed. FINAL supervisor owns that intentional P7 expectation update. All native edit/read/crash recovery fault cases passed.
- Focused TypeScript semantic/syntactic check after memory integration/new operation metadata: no diagnostics in17 owned/adapted source/test files. No repository-wide compile/build claim.
- Approval cancellation regression proves expired pending approval cannot execute later; approved running command is stopped and confirms quiescence before recipe timeout settles, with no delayed marker write. Original captured-lease/source/human-only/cumulative-check protections remain passing.
- Directory-parent links are now refused even within the root, preventing allowed lexical paths from redirecting writes to protected/ineligible targets. Existing linked-file/hardlink/config/traversal coverage passes.
- Operation status recovers validated small durable summaries from owning session notes after in-memory state loss; uncertain effects remain explicit. Large outputs stay in scoped artifacts.
-50-file fixture no longer launches one Git status per file: one abortable dirty snapshot is shared across the read call, invalidated after edits. This is an offline efficiency improvement, not a provider request/cost claim.
- Await-worker command failures now cancel outstanding approvals and wait running actions to quiesce, including deadline, abort, lease and policy failures. A crashed external executor without termination proof remains uncertain and requires P5 durable process recovery; this worker does not claim platform containment from mere close status.
- Native v2 startup and resume use bounded automatic memory via async brainContext/refreshMemoryMessages; fresh headroom includes source/system/tool/output allocation.
- No commits, live providers, trusted user config/data or downstream clone edits. Full repository checks/independent review remain FINAL supervisor responsibility.
