# Project-local runtime storage
Status: Active
Status detail: S0-S3 and Gate isolation verified locally; runtime registry and queue integration active. Migration/default activation and fresh Facebook live acceptance remain open.
Created: 2026-10-25
Last updated: 2026-10-26
Owner: Senior supervisor agent
Scope: Keep every project's runtime data inside its own directory with readable workspace hierarchy.
Paired document: none
Related: [working index](README.md), [delivery investigation](supervisor-lifecycle-stall.md)

## Current State

2026-10-26 latest checkpoint: S6a committed d042de0 after independent tools12+
registry19 PASS31/31. Brain/deletion22/22 independently PASS, committed ee7c5f8.
S6b committed985b43d, final evidence6+tools12 PASS18/18; recursive router/panel
typecheck PASS after short source freeze. Legacy evidence40/40 and crashes9/10
PASS; exact supervisor crash retry passes97.331s under bounded120s observation,
same original180s case limit and all source/result/deduplication assertions.
S5 queue5/5 author PASS, full fan-out next; Web7new+33legacy author PASS,
Brain local scope ports and Labs named-Job adapters active. No fresh Facebook
provider worker has started. Default activation/migration and full checks remain open.

### Worker brief: S6c private Brain and Web ports
- Worker: storage_split_contract. MAIN only; no worktree or source-repo runtime data.
- Read Current State here and storage-split-implementation-contract.md S6/S6c.
- Own web/access.ts, web/ledger.ts, web/backend-state.ts, new web/usage-reservations.ts,
  tests/project-brain-web-isolation.test.ts and report split-s6c-brain-web.md.
- Brain brain.ts/access.ts ownership starts ONLY after root explicitly releases C3 Brain.
- First implement/review Web boundaries while Brain acceptance runs. No service.ts edits.
- Private targets/results/errors/task/session joins must stay in actual pinned local store.
- Global backend state/quota needs explicit sanitized coordination ports and durable,
  idempotent cross-store reserve/settle; never global transaction opening local SQL.
- Preserve global per-day/backend limits across projects; no taskless bypass or duplicate quota.
- Legacy unbound stores retain explicit compatibility. Bound coordination rejects private data.
- Schema changes: send exact append/classification to sibling_cleanup_inventory first;
  do not edit migrations/store-role concurrently.
- No paid/network provider calls. OS-temp canonical project roots for fake integration tests.
- Report exact observed tests and remaining host wiring; no commits/shared doc edits.
- S6a is committed; worker-actions now belongs C3, do not edit it.
- Bounded expansion: harness/web-tools.ts caller adds captured taskLease; brain/promotion.ts
  optional publicProjection keeps private provenance local and uses opaque publicationDigest.

### Supervisor brief: native worktree removal evidence
- Own new workspaces/worktree-removal.ts, workspaces/worktree.ts,
  projects/deletion.ts and tests/worktree-removal-evidence.test.ts.
- Under existing common-owner capability, refuse known native lock/sequencer markers
  before native remove can erase per-worktree admin evidence. Preserve bytes and rows.
- This is a cooperative precheck, not an atomic CAS against unmanaged native processes.
- C3 Labs owner will consume the exported check at its removal sites after root tests.

### Supervisor brief: S6d shared port authority
- Own labs/ports.ts, new labs/port-reservations.ts and tests/project-lab-port-isolation.test.ts.
- Keep private Lab IDs/names/recipes in local store; coordination stores UUID/generation,
  opaque Lab/name digests and numeric host port only. Unique global port survives restart.
- Acquire global reservation before OS availability check and local projection; a local commit
  failure may overhold, never permit duplicate ownership. Same binding retries are idempotent.
- Release requires trusted local lifecycle proof after setup/service stop and kernel quiescence;
  no elapsed-time reclamation, model-provided waiver or global transaction reading local SQL.
- Ask S5 schema owner to append/classify shared reservations; do not race migration edits.
- C3 owns active Lab callsites; coordinate optional allocation port then integrate serially.

Latest user directive: finish the ENTIRE plan, keep live testing on Facebook, delete the old
Facebook project and start fresh. Clean all sibling variants; ALL project Labs/data belong
under the DOWNSTREAM project .MeritRouter. The router SOURCE REPOSITORY must have NO
.MeritRouter directory. No new development checkout; MAIN D:/SwitchYardRouter only.
These instructions supersede prior in-repository development/validation location rules.

All16 unfinished Lab/S0 files transferred byte-for-byte into main; Git preservation
checkpoint b2c6cd2 and exact OS-temp backup retained. Active code work is in main only.
C3.0 native message compatibility merged locally; root37/37 + containment16/16 PASS.
C3.1 lifecycle fence committed d332c6b: author53PASS/1POSIXskip, root full source review
and recursive typecheck/build PASS. C3.2 attribution/checked-tree activation implemented;
root final pending/setup/commit suite15/15 PASS. C3.4 runner/resume and command guards active.
Command guards committedb87f326: root24/24 command/write/resume +final command8/8 PASS.
Runner/resume committed7e49ad3; root11/11 within24. Queue committed442990e; root11/11 PASS,
full supervisor actual crash/restart/replay PASS95.15s after bounded fixture observation fix.
No final full-suite green. Latest draft TS onlyS4b narrowing issue corrected; rerun pending.
Root C3.5 repair final targeted4/4 PASS (pending source/target, nested capability, fresh-lease
resume); earlier22/23 identified self-lock now corrected, not a final full aggregate.
Root C3.6 Brain pending3/3 PASS; existing compatibility timeouts under worker diagnosis.
C3.7 deletion draft frozen; S4b registry integration under review.
C3.7 author5/5 PASS; rootprune capability bridge applied, independent rerun pendingC3.8.
C3.8 short Lab guards and kernel-backed long-service proof adapters active, not accepted.
Brain real Gate promotion now passes original deadlines after canonical ordinary write queue
and rootd208119 transient settlement retry; ordinary10/newguards17 pass, finalprojects8 running.
S0 role/identity committed567d236: strengthened19/19 independently PASS in main.
S1 minimal global accounting broker committed87f0945; root broker/identity/defaults/workspace
combined63/63 PASS, recursive typecheck PASS. S2 local protocol integrated locally;
no runtime/dispatch activation yet. Labs project-local filesystem/strict Compose
boundary committedd8dd7cd: root new18+Compose118+S019 =155/155 PASS. Author rebuilt-dist
Lab lifecycle57/57 PASS, incl real Chrome/kill/adoption/prune/deletion; C3.3 workspace guards
implemented and root12/12 PASS within combined63. Additional Lab lifecycle mutation fencing
remains C3.8 scope. No default service/store activation yet.
S2 committede0d669f: root protocol18+broker26+identity19=63/63 PASS48.13s.
S3 committed121be75, renewalc02c9c5: rootcapacity28/28 PASS in compatibility run.
Gate isolation committedf8959cb; root final5/5 PASS including two physical project DBs,
local prompts/output captures/classification, shared quota, foreign provider wiring refusal,
and runtime physical identity check immediately before transport (guard followup local).
S4b actual per-project Executor registry author16+Gate5 PASS; rootreview/install-source guard
correction in progress. S5 queue written brief queued for Brainworker after acceptance.
No new live provider calls or Facebook worker; current tests use fakes/OS-temp stores only.

User correction triggered removal of the accidental source-repo metadata tree. All12 sibling
SwitchYardRouter-* directories plus baseline/sy-wt are absent from D:/ after checked relocation.
Approval demo1583 files byte-verified in retained archive; baseline291 blobs independently
verified already in Git. Permanent cache removal twice rejected by automatic review with
only blocked-by-policy; Windows recoverable removal returned sharing violation32. Inactive
leftovers moved atomically into existing machine package cache D:/.pnpm-store/meritrouter-agent-cleanup-20261026.
Router source .MeritRouter is now ABSENT (also after restored passive MCP/panel). Panel and
passive MCP were restored after the verified temporary stop. No checkout/cache may run from
the quarantine; all code authors/tests use MAIN. No new alternate checkout allowed.
Hidden12 worktrees and one unregistered residue also retired; Git admin backups byte-verified
in OS TEMP, pointer files detached and invalid registrations pruned. Git lists ONLY MAIN.
Agent checkpoint/validation evidence is in normal OS temp (not repository .MeritRouter).

Old Facebook deletion submitted ONCE via supported DELETE after preview no blockers:
61tasks/8jobs/77sessions/277artifacts/57worktrees,1690requests retained for accounting,
1unresolved transport hold conservatively quarantined. HTTP request timed out240s; actual
project registry now shows only my-project/tetris/pomodoro. No duplicate deletion submitted.
Filesystem check: only9 unrelated global worktree dirs remain, no Facebook Git bindings;
old brain project folder absent. Canonical Git-only source retired to OS-temp recovery and
verified HEAD566a315 + git fsck exit0; empty hidden shells removed nonrecursively. Canonical
Facebook path is now ABSENT. Fresh creation must mint new UUID and source history.
Fresh live trial announced400 model requests/$0paid; no new provider calls yet. Do not start
fresh runtime through old global storage defaults merely to claim testing: enforce project
path/store ownership first, then operate the real fresh pilot. Codex authors no Facebook app.

Plan sequence remains C3 activation (message/fence/attribution/workspace/resume/integration/
Brain/deletion), S0-S11 store/accounting/queue/runtime/migration and actual pilot/approval UX/
repeatability acceptance. Contracts: reports/metadata-caller-activation-contract.md and
reports/storage-split-implementation-contract.md. Continue execution, not just prerequisites.
Baseline source publication e5989ce; latest main changes are local/unpublished pending checks.
Earlier full1854:1801PASS/49Compose-fixtureFAIL/4SKIP; corrected failed files118/118 and
combined216PASS/1SKIP with recursive checks PASS. Do not invent a final green full aggregate.
Historical prerequisite details preserved in archive/2026-10-26-prerequisite-current-state.md.

## Intended layout

```text
<project>/
  <delivered application source>
  .MeritRouter/
    project.json
    state/
    brain/
    sessions/
    artifacts/
    jobs/
      <readable-job-name>--<stable-id>/
        versions/
          <readable-branch-or-version>--<stable-id>/
            repositories/<repo-alias>/
        tasks/
          <readable-task-name>--<stable-id>/
            attempts/<attempt-number>/repositories/<repo-alias>/
```

Layout is a design proposal pending source discovery. Delivered source remains visible at
project root; `.MeritRouter` is private runtime state and must be excluded from Git and
recursive agent file discovery. Slugs must be bounded, Windows-safe, stable after renames,
and collision resistant. Multi-repository projects use the registered project directory.

## Implementation phases

1. Map path ownership and every consumer; settle project root resolution and shared-state
   boundaries before writing source. Record exact migration and compatibility contracts.
2. Add one validated project-path resolver, readable stable labels, containment checks,
   metadata exclusion, and new-project defaults. Partition implementation briefs by file.
3. Migrate existing projects with stopped/quiescent owners, backup, dry-run manifest,
   Git-aware worktree relocation, typed reference updates and rollback. Preserve charges,
   history, approvals, source identity and original Git attribution. Refuse ambiguous roots.
4. Update panel path presentation, cleanup/deletion, recovery, CLI/MCP and authored docs.
5. Verify fresh creation, multi-repo jobs, retries, restart/resume, migration failure/rollback,
   deletion containment and Windows paths. No project-owned writes under install root.
   Run required full checks and demo-panel visual verification for touched UI.

### State/accounting decision

Use explicit project runtime handles before physical store separation. Current request
reservation, task generation checks, provider slots, task charges and paid holds share
one SQLite transaction. WAL does not make multiple independent databases crash-atomic.
The proposed split must use durable local preparation/global reservation/settlement receipts,
idempotent IDs, conservative unresolved holds, and fenced dispatch; no network awaits inside
transactions. Preserve same-project batching and existing accounting authority.
Detailed proposal: reports/state-service-contract.md. Full schema/caller ownership inventory
is underway before approving physical DB split implementation. Do not copy global credentials
or private payloads into a misleading partial project store and call migration complete.

## Worker Briefs

### Activation wave (2026-10-26, Claude Code supervisor)

Decision: split activation is installation-wide, never mixed. A bound coordination DB rejects
private rows, so legacy projects must be migrated (S10) before the installation flips. Config
`storage.layout: legacy|project` (default legacy for existing installs). In `project` layout
startup refuses dispatch if the installation DB still holds unmigrated project-private rows.
Service API contract shared by all briefs (supervisor added `labsFor` stub):
`projectStores(slug)` -> bundle stores in project layout; `brainFor/brainAccessFor(slug)` ->
split Brain; `labsFor(slug)` -> per-project LabManager. Admin/CLI read only through these.

#### A split-host-activation
- Own core/service.ts, config/schema.ts, config/load.ts, new core/project-runtime-host.ts,
  new projects/store-provisioning.ts, admin/projects.ts createProject only,
  tests/project-split-activation.test.ts, reports/split-host-activation.md.
- Layout flag; coordination binding of installation DB with refusal when legacy private rows
  exist; provisioning (mint identity, `<dir>/.MeritRouter/state`, project role, register,
  project.json manifest); real privateServices (split Brain/BrainAccess/WebAccess with
  usage/backend ports, LabManager with port authority + ProjectLabCapacity, servicesForLease);
  broker/grants/ProjectQueueBindings/ProjectScheduler replacing the legacy Scheduler.
- Route every per-slug service method (submit/status/list/collect/cancel/accept/reject/
  questions/resume/usage/recover/startJob) to the bundle. Project without directory refuses.
- Fake-provider test: fresh install in project layout, two projects, submit->complete, data
  only in each project store, zero private rows in installation DB, restart reopens.

#### B s6d-lab-capacity-integration
- Own labs/lab.ts, labs/task-attempt-runner.ts, labs/task-attempt.ts, labs/task-attempt-prune.ts,
  labs/project-capacity.ts, workspaces/repository-command.ts, tests/project-lab-capacity.test.ts,
  reports/split-s6d-lab-capacity.md. Wire reserve/release callsites per that report; optional
  LabManager `capacity` option (A passes it). Legacy unchanged.

#### C s10-store-migration
- Own new projects/store-migration.ts, projects/store-export.ts, projects/store-path-references.ts,
  tests/project-store-migration.test.ts, reports/split-s10-migration.md. Library only (no CLI,
  no admin/deletion edits). Dry-run manifest, WAL-aware backup, FK-ordered export per
  ownership-inventory, Git-aware worktree moves, typed path rewrite, registration switch,
  rollback before dispatch, restart detection. OS-temp fixtures only.

#### D1/D2 s7-admin-reads
- D1 owns admin/live.ts, entities.ts, insights.ts, session-project-scope.ts, request-evidence.ts,
  dashboards.ts, sessions.ts. D2 owns the remaining admin files from the activation map except
  projects.ts. Per-project reads via the service API above with explicit project filters (works
  in both layouts); missing/unavailable project store yields an explicit unavailable state.
  Tests: tests/project-admin-store-isolation.test.ts (D1), tests/project-admin-job-reads.test.ts (D2).

### S6d capacity: c3_message
- MAIN only. Read Current State and split-s6d-lab-ports.md; C3.8 existing sources frozen
  until supervisor accepts the running independent native/adapter selection.
- Initially own ONLY new labs/project-capacity.ts, tests/project-lab-capacity.test.ts and
  report split-s6d-lab-capacity.md. Propose exact append/classification to S5 schema owner.
- Implement explicit sanitized global installation max_active/max_services authority with
  project/store UUID+generation and opaque Lab/service name digests; no recipes/paths/prose.
- Trusted constructor limits callback must validate global caps, not model-selected limits.
- Local IMMEDIATE proof precedes global transaction; global SQL never reads local state.
- Reserve after durable local creating/starting intent, before native transport/process grant.
- Same binding replay/adoption holds one slot. Crash/local rollback may overhold; no age-based
  reclamation, process-snapshot waiver, cancellation refund or blind row purge.
- Retained stopped Labs keep Lab slots until destroyed. Task-attempt slots retire only after
  durable retained/pruned phase and exact stopped process/command evidence. Service backoff
  keeps its slot; terminal stopped/failed release requires exact own kernel-zero retirement.
- Validate actual local Lab/service/task-attempt row ownership, identity and state with Zod.
- Tests: real temp FULL two-project stores, duplicate IDs/names, shared cap refusal, replay,
  rollback/unknown-proof hold, generation invalidation, service/Lab independent release.
- No existing Lab callsite edits yet. Report required minimal integration callbacks for root
  approval once C3.8 source accepted. No commits/shared docs/new checkout/provider calls.

### c3-tool-command-guard
- Role: implementation MAIN only; no .MeritRouter in source repo or new checkout.
- Own harness/tools.ts, edit-operations.ts, operation-lifecycle.ts, loop.ts, worker-actions.ts;
  new workspaces/repository-command.ts; minimal repository-mutation.ts active-command hook;
  unique tests/project-metadata-command.test.ts and project-metadata-tool-write.test.ts;
  own reports/c3-tool-command-guard.md. Original four runner/resume files owned by c3_message.
- Short actual FS-write leases, typed unresolved errors rethrown through V2 partial/loop catches;
  host hook mandatory in native/supervisor wiring, optional only for independent non-Git tools.
- Approved long checks: durable exact per-worktree active-command receipt created before spawn
  under SHORT common lease; mutations honor it during process lifetime. No common lease across
  process wait; pending human approvals create NO active receipt. Retire only with verified
  process-tree quiescence or definitely-unsent spawn proof; unknown/crashed owner preserves guard.
- Minimal FS receipt IDs/nonces/digests; full command/review payload remains project store.
  Host-only own-receipt retirement permit, never model input, no broad ignore-all-active flag.
- Coordinate injection/signatures with runner author; no edits to their owned files.
- Actual delayed/competing command+write/commit tests, failed spawn/exit/kill and unknown
  descendants/abandoned guards, no fake quiescence. No locks over SQLite awaits/model calls.
- Report any process-containment limitation instead of treating parent exit as full proof.
- Focused tests then freeze; no broad checks/live commands/providers/shared docs/commits.

### split-s2-local-protocol
- Role: implementation MAIN only; no alternate checkout/source-repo metadata.
- Read S1 frozen broker API/report, state-service and storage-split contracts.
- Own admission/admission.ts, sqlite-request-ledger.ts, request-receipts.ts, request-ledger.ts,
  job-pool.ts, budget-requests.ts; new admission/project-request-ledger.ts plus specifically
  named local preparation/projection modules if needed; append-only migrations.ts and store-role
  classification for LOCAL rows; unique tests/project-accounting-protocol.test.ts and own report.
- Propose additional actual accounting-file ownership before touching; no Gate/capacity/service.
- Implement durable local prepare/holds -> global reserve -> local bind -> synchronous local
  IMMEDIATE then global IMMEDIATE dispatch intent -> local commit. No await/network in SQL txn.
- Dispatch replay never grants transport; derive dispatchNotAfter from actual local task/lease
  deadlines, recheck before handing out fresh process-owned authority. Broker alone is not cap.
- Exact owner/store UUID/generation/incarnation binding, conservative original task/grant holds;
  global same-ID settle then idempotent local charge/spend projection, no blind refund/retry.
- Persist private bindings/output/error/captures locally only. Global cost-quarantine error is
  durable evidence; retain local liability and stop dispatch, never report free or complete.
- Preserve legacy same-DB adapter behavior; don't pretend task budgets live in global broker.
- Actual two-store crash/fault/concurrent cancel/claim/dispatch/replay tests at EACH durable
  boundary plus same-project batch/job pools. No project copies of shared credentials/keys.
- S3 later supplies UUID-bound global slots; tests use trusted fake authority, never real API.
- Focused tests and freeze/report; no broad checks/live writes/providers/shared docs/commits.

Historical completed/superseded briefs: [archive](project-local-storage/archive/2026-10-26-completed-foundation-briefs.md).

### c3-resume-runner-activation
- Role: MAIN checkout only. Read C3.4 contract + frozen attribution/workspace API reports.
- Own harness/resume.ts, runners/coding/native.ts, runners/coding/finish.ts,
  runners/supervisor.ts, new tests/project-metadata-resume.test.ts and own report.
- Propose any extra source ownership first (especially harness loop/tool mutation boundary).
- Guard BEFORE sequencer abort/reset/reuse/per-response writes/status updates; propagate
  typed pending/uncertain/index-pending effects so no false pointer/unchanged/not-applied proof.
- Abort errors surface; no blind resets, auto retries or HEAD rollback after unresolved commit.
- Pass opaque host mutation capabilities into nested Worktrees/commitAs calls; scope short
  repository mutation sections only. NEVER hold common-owner lease across model/provider calls,
  await_tasks, human approvals or long-running check processes.
- Trace model FS tools/approved checks admission: entry-only guard must not allow writes to a
  retained pending-publication worktree; propose correct existing-authority hook if needed.
- Real temp pending fixtures compare files/index/HEAD/session pointer/status/receipts; original
  successful resume/runner/recovery behavior preserved. Fake providers only, no live project.
- Source may be read/proposed during root typecheck, edit only after root signal. Focused tests
  after own freeze; no global builds/shared docs/commits/new checkouts or repo metadata.

### split-s1-broker
- Role: implement in MAIN checkout ONLY; no .MeritRouter or alternate development checkout.
- Read Current State, S0 APIs and storage-split-implementation-contract.md S1 protocol.
- Own new admission/accounting-broker.ts, sqlite-accounting-broker.ts, optional specifically
  named accounting-usage.ts; paid/spend.ts; append-only storage/migrations.ts; storage/store-role.ts
  classification update for new tables; unique tests/project-accounting-broker.test.ts;
  own reports/split-s1-broker.md. No other admission/Gate/service files yet.
- Synchronous validated minimal DTOs, reserve/dispatch/settle/read/definitely-unsent retirement;
  immutable project/store generation/UUID binding, exact fingerprint replay, outcome digest CAS.
- New global physical_requests/broker_paid_spend contain no private binding/prose/path/payload.
- Preserve conservative unknown transport/cost liability; intent replay never grants transport.
- Deduplicate legacy/new request IDs for package/spend math; no request-count refunds or
  deleted-project slug reuse. Check trusted coordination registration, key/slot/nonce authority.
- Temp two-store/fake-provider tests at durable boundaries, conflicts, quotas, legacy coexistence,
  recreation and definitely-unsent vs uncertain outcomes. No live money or provider calls.
- Source edits may proceed; NO native/test process until root signals cold cleanup complete.
- No shared docs/commits/pushes; propose DTOs early, test after signal, freeze/report exact results.

### c3-attribution-activation
- Role: implement in MAIN only; no .MeritRouter or alternate checkout.
- Read Current State, C3.2 activation contract and frozen C3.0/C3.1 APIs/reports.
- Own attribution/index.ts, checked-candidate.ts, optional actor.ts with preserved reexports;
  selected-commit.ts only for exact captured-tree publication API; tests/attribution.test.ts,
  new tests/project-metadata-commit.test.ts and own reports/c3-attribution-activation.md.
- commitAs success remains string|null; map legacy paths undefined/[] to ALL. Preserve
  native messages/Actor identity/trailers; typed pending/refused/uncertain/index-pending errors.
- Fence undo BEFORE filesystem/revert effects; propagate a host-only capability through nested
  calls, no widening or public model capability. Expose abort failures instead of swallowing.
- Checked candidate MUST publish exact previously captured tree under same fence/native locks/
  durable receipt protocol; preserve authority checks and never restage/reread newer app bytes.
- Propose captured-tree API before widening selected-commit internals. No raw update-ref bypass.
- Real temp tests legacy path semantics, staged A/partial B, exact captured tree, pending refusal
  before undo edits, identity/messages, races and typed outcomes. No caller files outside ownership.
- Source edits only until root ends cold cleanup; then focused tests, freeze/report. No broad checks.
- No live projects/providers/shared docs/commits/new checkouts.

### c3-workspace-activation
- Role: implement MAIN only; no source-repo .MeritRouter or alternate checkout.
- Own workspaces/worktree.ts, repository-prepare.ts, projects/repository-setup.ts,
  tests/repository-prepare.test.ts, new tests/project-metadata-worktree.test.ts;
  reports/c3-workspace-activation.md. C3 attribution author owns selected APIs; coordinate signatures.
- C1 exclusions before initial snapshots; C2 stage collection; C2b fixed initial commits.
- Fence prepare/source+target reuse/remove and collection under C3.1 common-owner leases.
  Preserve existing task scope/protected-path/immutable base behavior; no swallowed remove success.
- Guard pending publication before status/DB/FS side effects. Preserve exact registered source
  junction identity through physical Git owner resolution, not by weakening metadata aliases.
- New ordinary task path activation remains S9; don't pretend this alone moves project data.
- Existing legacy setup/collect/remove tests + meaningful pending/alias/metadata/temp-Git tests.
- Source edits only until root ends cold cleanup; focused checks after signal, freeze/report.
- No broad checks/live data/provider calls/shared docs/commits/new checkouts.

### c3-merge-queue-activation

Owner: c3_message after runner freeze. Status: Assigned.
Files: workspaces/merge-queue.ts, tests/project-metadata-merge-queue.test.ts,
reports/c3-merge-queue-activation.md only. Root owns repair-hydration.ts and its tests.
Brief: guard pending publication/active commands before recovery state or Git side effects;
branch mutex then short sorted common-owner leases then native Git locks. No lifecycle lease
across checks, redelegation, human/model waits. Propagate typed unresolved outcomes without
rollback; expose abort failures. Restore only proven owned pick chain, never foreign advance.
Preserve durable branch mutex/replay semantics. Validate real Git pending/race/recovery cases
and relevant existing queue tests; report exact results/limits, no commit/push/shared-doc edits.

### c3-brain-activation

Owner: sibling_cleanup_inventory (supervisor draft handed off). Status: In progress.
Files: brain/brain.ts, tests/project-metadata-brain.test.ts, tests/brain.test.ts,
tests/projects-brain.test.ts, reports/c3-brain-activation.md only.
Fence Git-backed initialization, writes, adoption and removal before file/index effects;
preserve mount and literal path boundaries, optimistic digests and typed publication outcomes.
Forward host capabilities into attributed commits. Keep optional remote push outside leases.
Verify actual retained-publication refusals and ordinary Brain behavior after shared modules ready.
Root new3/3 pending tests pass; existing projects-brain snapshot6/8 timeout30s with cascading
cleanup and brain.test still running root session1697. Diagnose actual cause with one-case
bounded diagnostic before changing assertions/timeouts; preserve every authority assertion.
Root will stop/drain that old run before replacement loops. Native test bootstrap fixture is
root-owned and committedb7a0c5b; original-hook exact case passes. No native fixture edits.
Coordinate deletion host API: optional {mutation} through ensure/removeProjectFolder and
README write without nested reacquisition. Propose exact public host shape to root and c3_message.
Do not hold leases across Git push. No new checkout/provider calls/shared-doc edits/commits.

### c3-project-deletion-activation

Owner: c3_message after merge-queue freeze. Status: Queued, not dispatched yet.
Files: projects/deletion.ts, admin/projects.ts, tests/project-metadata-deletion.test.ts,
reports/c3-project-deletion-activation.md. Brain host-control extensions require root coordination.
Discover relevant worktree/Brain pending publications before Lab prune, config rewrite or SQL
purge. Hold sorted common-owner authority through destructive lifecycle; revalidate under
scope. Preserve private recovery evidence and global usage/holds. Never swallow native remove
failure then count removal; validate actual paths/physical owners, no foreign lock writes.
Missing/unverifiable workspace ownership refuses explicitly. Do not hold SQLite tx across await.
Coordinate nested Worktrees/Brain capabilities; never reacquire an outer common lock.
Real receipt fixtures must prove unchanged config/rows/files before refusal; ordinary confirmed
deletion must retain accounting and worktree branches. Report exact failures/limits, no push.

### c3-lab-mutation-activation

Owner: c3_message after deletion freeze. Status: Queued, not dispatched yet.
Files: labs/lab.ts, task-attempt-runner.ts, task-attempt.ts, task-attempt-prune.ts;
tests/project-metadata-lab.test.ts; reports/c3-lab-mutation-activation.md.
Request additional files before edits; existing deletion caller capability bridge serialized
with that worker's deletion brief. Discover raw Git worktree create/refresh/merge/remove and
recursive prune effects; gate actual owning source+worktree before writes/DB status changes.
Preserve existing LabEffect ownership and process/Docker cleanup proofs. Common-owner scope
must not span service lifetimes, provider/human waits or checks. Short filesystem/Git effects
only; keep unresolved publication/command outcomes typed, no abort/reset/delete fallback.
Forward optional host capability from confirmed project deletion to avoid self-deadlock.
Verify retained empty-publication receipt even with clean HEAD/index, forged owner/path and
ordinary Lab/task-attempt lifecycle. No new checkout/provider calls/shared-doc edits/commits.

### split-s3-capacity

Owner: storage_split_contract. Status: Assigned.
Files: gateway/capacity.ts, gateway/quarantine.ts, routing/claim-capacity.ts,
new storage/project-execution-grants.ts, tests/project-capacity.test.ts,
reports/split-s3-capacity.md. Append migrations/store-role only for new global grant schema.
Read Current State and storage-split-implementation-contract.md S3/authority sections.
Remove local task joins from NEW split-mode global slot ownership; retain legacy explicit
compatibility. Pin immutable project/store UUID/generation plus owner/incarnation/run and slot
nonce to actual global execution grants. No private task copies in global store. Conservative
unresolved physical holds survive owner loss/reopen; parent exit/lease age does not prove send
absence. Claim authority consumed/revoked exact-once; stale recreated projects cannot inherit.
Coordinate stable APIs with root S4a Gate constructor/dispatch injection before altering ports.
Fake two-project capacity/last-slot/reopen/stale-generation tests; preserve legacy capacity tests.
No service/Gate activation, provider calls, new checkout, commit/push/shared-doc edits.

### split-s4a-gate

Owner: Supervisor. Status: Starting after S2 acceptance.
Files: gateway/gate.ts, gateway/direct.ts, routing/router.ts, scoring/classifier.ts,
providers/runtime.ts (explicit DB wiring predicate only), tests/project-gate-isolation.test.ts,
reports/split-s4a-gate.md.
Inject explicit project versus coordination stores and ProjectRequestLedger; consume fresh
dispatch authority immediately before transport. Private captures/classification remain local;
global catalog/health/quota/keys/capacity stay shared. No implicit root-DB project scoping.
Coordinate S3 stable capacity inputs. Fake two-project end-to-end request slice before runtime
bundle/service activation. No live provider call until complete isolation/migration.

### split-s3-renewal

Owner: storage_split_contract. Status: Assigned after committed121be75 S3.
Files: storage/project-execution-grants.ts, appended storage/migrations.ts and store-role if
needed, tests/project-capacity.test.ts, reports/split-s3-capacity.md.
Keep original grant binding immutable; authority_expires_at/renewal_sequence updated via
nonce/project/store/generation/exact lease/expected-sequence CAS. Trusted synchronous host
resolver returns verified local maximum deadline; caller holds local IMMEDIATE and validates
actual lease/deadline/cancel authority before global renewal, no global-to-local transaction.
Lost local commit only overholds global. No expiry auto-refund, nonce rotation, participant
substitution or model-supplied authority. Append new migration; test stale generation/sequence,
changed owner/incarnation and local commit failure. No runtime activation/shared-doc/commit.

### split-s4b-runtime-registry

Owner: storage_split_contract after renewal freeze. Status: Queued.
Files: projects/runtime-store.ts, new projects/runtime-registry.ts, core/service.ts,
core/executor.ts, sessions/run-sessions.ts, tests/project-runtime-registry.test.ts,
reports/split-s4b-runtime-registry.md. Request further actual ownership before edits.
Construct real separate project DB/service bundles pinned to registered UUID/store/generation;
explicit project services at execution/lease/session end paths. Installation db remains shared
coordination, never a pretend scoped SQL facade or first-project getter. Root S4a Gate optional
ProjectGateContext stable; use project ledger/captures/router plus shared providers/health/grants.
No global copies of task graph, payloads, approvals or private evidence. Missing/retired/mismatched
store fails closed, never silently recreates data. Legacy mode explicit pending S9/S10 switch.
Real two-project fake-request/session/close/generation tests before next scheduler phase.
No provider calls/new checkout/shared-doc edits/commit; coordinate stable S5 queue API with root.

### promotion-settlement-contention

Owner: Supervisor. Status: In progress; core/service.ts held from S4b worker.
Files: core/service.ts, tests/promotion-settlement-retry.test.ts, own report.
Actual completed reviewer task emits settled; Brain publication gets typed lock_busy and
automatic callback swallows it, leaving promotion pending indefinitely. Brain worker fixes
ordinary common-owner queue. Root adds bounded transient lock_busy settlement retries using
existing tracked timers, cancels onclose, never retries unresolved publication/command proof.
No extra model request or changed task/transport deadline. Verify retry/recovery-required/close
cases, then release service.ts to S4b. Keep existing exact result/lease authority checks.

### split-s5-queue

Owner: sibling_cleanup_inventory after Brain freeze. Status: Queued/read-design first.
Files: core/scheduler.ts, storage/sqlite-task-queue.ts, storage/sqlite-task-leases.ts,
storage/fair-claim.ts, core/task-run-leases.ts, storage/tasks.ts host-only claim ordering;
new core/project-scheduler.ts; bounded gateway/capacity.ts, routing/claim-capacity.ts and
storage/project-execution-grants.ts sealed-batch unit correction; append migrations/store-role
for explicit private claim markers; tests/project-queue-isolation.test.ts,
reports/split-s5-queue.md. Request extra actual files before edits; service bridge root-coordinated.
Read S4b registry/services stable APIs and S5 contract. Global coordination fairly fans out
project-local queues; one real Executor per project bundle, no root task copies/SQL facade.
Local IMMEDIATE validates/seals chosen same-project group and reserves minimal global grant
in local->global order; LOCAL COMMIT, then fresh global consume/provider claim, then LOCAL
started-marker CAS COMMIT, only then executor. No replay/lost local commit starts execution.
Sealed completion batch is one real execution/claim unit with immutable full participant set;
supervisor/writer grants single-lease. Capacity rejects subset use of a combined batch grant.
Replayed global grant never starts a second run. Failed local commit only overholds global.
Renew actual local lease under same ordering with trusted renewal bound; never age-refund
physical slots. Keep actual task graph/glob leases local. Move claim_pass shared fairness
meta to explicit global authority; do not weaken S0 project metadata guard as a shortcut.
Exact project UUID/generation/lease on heartbeat/cancel/end/recovery, even duplicate task IDs.
Verify two-project fair claims, last-slot, rollback/reopen/cancel/renew/no-double-executor and
private DB isolation with fake providers. No default activation until remaining consumers ready.
No providers/new checkout/shared-doc edits/commit; coordinate root S6 operations partition.

### split-s6a-project-tools

Owner: storage_split_contract after S4b acceptance. Status: Assigned.
Files: harness/supervisor-tools.ts, harness/budget-tools.ts, harness/worker-actions.ts,
core/supervisor-authority.ts; new core/project-services.ts if it owns scoped runtime callbacks;
tests/project-tool-store-isolation.test.ts, reports/split-s6a-project-tools.md.
Read S4b actual bundle/runtime-services API and S6a contract. Every graph, approval, grant,
command and supervisor-authority operation uses the pinned local project bundle; no root DB
escape, cross-project lookup or first-project getter. Shared provider/capacity/accounting only
through explicit sanitized ports. Stable per-project RunServices callback factory should make
it difficult to accidentally pass installation task/session stores; coordinate runtime-services
type bridge before edits and propose exact extra source ownership. No default service activation.
Model-supplied project/parent/task IDs cannot widen owner scope, including duplicate task IDs
in different stores and stale reused slug. Preserve C3 command guards/approval semantics.
Verify actual two-project tools/approval/grant writes and zero private global rows with fakes;
reject foreign parent/sessions/generation before side effects. Request migration ownership if
needed (S5 currently owns append schema/role). No providers/new checkout/shared-doc/commit.

### split-s6b-private-evidence

Owner: Supervisor. Status: In progress.
Files: storage/request-captures.ts, storage/artifacts.ts, storage/usage.ts,
sessions/store.ts, sessions/recorder.ts; new storage/project-evidence-scope.ts;
tests/project-evidence-isolation.test.ts, reports/split-s6b-private-evidence.md.
Pin actual store identity/generation for private evidence, fail on coordination-role access,
retain explicit legacy-unbound compatibility. Project files use canonical owning .MeritRouter
root (including classifier sessions), never cfg.state/sessions split or external supplied root.
Validate task/execution/session ownership before private file effects; exact stamped project
for taskless local sessions; preserve existing append/replay/capture/privacy semantics.
No global task joins/copies or fabricated telemetry. Reject pointer/link/owner changes before
FS effects, verify two actual project stores and unavailable foreign refs. No schema edits;
S5 owns schema/role. Default activation remains separate; no live providers.

## Work Ledger

### 2026-10-26 — Accept S5 queue, S6c Brain/Web and S6d Lab capacity ports
- Agent: supervisor (Claude Code); prior workers sibling_cleanup_inventory, storage_split_contract, c3_message
- Changed: S5 coordinated project queue/scheduler host controls, S6c pinned Brain/Web ports and
  Web usage reservations, S6d Lab capacity authority (callsites not yet wired); `labsFor` stub.
- Validation: `pnpm -r typecheck` PASS. Focused 17 files 241 PASS / 2 FAIL 491s; failures are
  team-capacity scheduler admission (in-flight wait 20s and afterEach close >10s). Same test
  fails with HEAD scheduler.ts swapped in; a diagnostic rerun passed the body and timed out only
  in close(). Classified as slow service close (also seen as 11-29s fairness close), not S5
  claim logic. Removed leftover fairness timing console.log; kept warmup and 120s teardown.
- Outcome: Partial — ports accepted; slow-close diagnosis assigned; host activation next.
- Follow-up: activation wave A-D (see Worker Briefs); full suite/build after integration.

### 2026-10-26 — Freeze global broker and continue caller activation

- S1 committed locally87f0945 after independent63/63 combined broker/identity/defaults/workspace
  checks and recursive typecheck. No runtime activation or provider calls; unpublished.
- C3.2 root final selected-commit suite15/15 PASS; C3.3 root12/12 PASS in combined63.
- C3.4 resume/runner and durable command guard workers active; S2 local protocol active.
- Root owns C3.5 repair-hydration.ts and its existing test file: source+target lifecycle fence,
  nested capability forwarding and pending-before-receipt regression tests; validation running.
- Latest full status delivered to user; remaining store wiring/migration/live acceptance explicit.
- Twelve merged historical .claude/worktrees checkouts Git-moved to existing quarantine;
  dirty source and logs retained. Unregistered overview-horizons leftover moved alongside them.
  .claude/worktrees now empty; source .MeritRouter remains absent. No permanent deletion claim.

### 2026-10-26 — Integrate standalone storage prerequisites and folder policy
- Agent: supervisor; workers selected_commit_resume and selected_commit_review
- Changed: C1/C2/C2b and fixture corrections merged into dev17182ad after dev sync882e53e.
- Why: Finish paused prerequisites without activating incomplete callers or moving project data.
- Validation: root six-file compact/metadata/Compose run216PASS/1POSIXskip159.12s; recursive typecheck/build PASS; packages/apps diff between checked feature and merged dev empty.
- Outcome: Accepted standalone prerequisites. Full1801PASS/49FAIL/4SKIP remains recorded; exact failed files corrected and independently118/118 then combined118/118 PASS, not a new green full aggregate.
- Follow-up: C3.0 message parity, C3.1 mutation fence, then wrapper/lifecycle activation per contract; physical store split/migration later. Keep current internal tree for this active unit, no external folders removed.

### 2026-10-26 — Resolve full-suite checkout-sensitive fixtures
- Agent: supervisor; worker selected_commit_resume
- Changed: only two Compose fixture files and their report in isolated tree.
- Why: Pure virtual approved mounts inherited .MeritRouter cwd and correctly hit metadata guard.
- Validation: full1854 exit1:1801PASS/49FAIL/4SKIP1040.21s; root baseline main two-file118/118 PASS; root corrected isolated two-file118/118 PASS1.04s. All61 executable C1/C2/C2b cases passed in full run.
- Outcome: Accepted fixture correction; no production guard/assertion relaxation, no final full-green claim.
- Follow-up: merge current dev into feature and check combined compact paths/metadata plus recursive checks before integration/publication.

### 2026-10-26 — Repair isolated validation dependency
- Agent: supervisor
- Changed: isolated ignored node_modules only; no source/runtime change.
- Why: Full suite emitted missing better-sqlite3 native binding; stopped exact owned test process tree.
- Validation: isolated `pnpm --filter meritrouter rebuild better-sqlite3` exit0; in-memory SQLite `select 1 as ok` returned `{ ok: 1 }`.
- Outcome: Partial; interrupted original run is not accepted. Fresh full run underway with maxWorkers3.
- Follow-up: inspect full-after-dependency-rebuild.json; no changes to live SQLite/configuration.

### 2026-10-26 — Review resumed selected-commit corrections
- Agent: supervisor; workers selected_commit_resume and selected_commit_review
- Changed: isolated C2b draft corrections/tests and separate author/reviewer reports.
- Why: Finish paused concurrency/topology blockers with bounded terminal receipt retention.
- Validation: root main and isolated `pnpm -r typecheck` PASS; isolated `pnpm -r build` PASS. Root focused/full router checks running, not yet accepted.
- Outcome: Partial; independent review report read, no new standalone prerequisite blocker.
- Follow-up: inspect exact root test output; retain explicit message/caller/power-loss limits; no runtime activation.

### 2026-10-26 — Resume and prevent sibling worktree sprawl
- Agent: supervisor
- Changed: AGENTS.md, Current State/handoff/readiness checkpoint and drive-root-worktrees report.
- Why: User resumed execution and required no more alternate development folders in D:/.
- Validation: twelve `git merge-base --is-ancestor <HEAD> dev` checks exit0; tracked/nonignored untracked inventories empty; ignored build/demo state retained; `git diff --check` exit0.
- Outcome: Accepted policy/investigation; no directory removal or runtime migration.
- Follow-up: selected_commit_resume owns C2b in existing in-project tree; independent review and supervisor checks required before acceptance. External cleanup deferred pending evidence/launch-reference inventory.

### 2026-10-26 — Verify and commit isolated exclusion preflight
- Agent: supervisor; workers project_directory_config and runtime_path_contract
- Changed: isolated feature branch2cb0e0e adds metadata-exclusion helper/tests/reports only.
- Why: Protect existing tracked/indexed data and preserve effective private ignore rules before staging integration.
- Validation: root isolated18/18 PASS33.30s and package typecheck PASS; independent effective-negation/maxsize probes clear after two corrections.
- Outcome: Partial
- Follow-up: C2 host-owned transactional staging, C3 caller integration and exact-source guards; no activation yet.

### 2026-10-26 — Close alias leak and verify corrected foundation
- Agent: supervisor; workers runtime_path_contract,project_directory_config,project_storage_discovery
- Changed: reader physical preflight/hardlink refusal and regressions; independent review updated.
- Why: Git traversed ordinary Windows junction aliases into private metadata.
- Validation: final combined six-file tests90/90 PASS23.50s; recursive typecheck PASS; rebuilt-dist temp probe returned only app.txt/PUBLIC and refused junction+hardlink reads. Independent12/12 and actual probe PASS.
- Outcome: Partial
- Follow-up: final build/full checks, commit foundation; staging guards and physical store/migration remain.

### 2026-10-26 — Independently reproduce metadata alias exposure
- Agent: supervisor
- Changed: no source; disposable temp-Git fixture created and cleaned.
- Why: Verify review finding through actual built RepoReader rather than a worker claim.
- Validation: Node ESM fixture importing dist RepoReader/git ->list returned alias/private.txt and hard-alias.txt; search returned PRIVATE_FIXTURE under both aliases; direct hardlink read returned PRIVATE_FIXTURE.
- Outcome: Blocked
- Follow-up: fix reader physical filtering/hardlink policy, regressions and independent recheck before acceptance.

### 2026-10-26 — Inventory ownership and review store seam
- Agent: supervisor; workers project_storage_discovery and project_directory_config
- Changed: state/accounting design,70-table inventory, same-DB handle and executor/service wiring.
- Why: Avoid breaking atomic accounting while introducing project-specific service ownership.
- Validation: disposable migrated SQLite schema compared with report ->70 tables,70 ownership rows,missing=[],extra=[]; independent seam/projects tests19/19 PASS11.28s.
- Outcome: Partial
- Follow-up: metadata write boundary, final combined checks and physical-store protocol implementation.

### 2026-10-26 — Implement and verify foundation contracts
- Agent: supervisor; workers runtime_path_contract and project_directory_config
- Changed: runtime-paths.ts, project schema/resolve/context/registry and two focused test files; setup documentation.
- Why: Establish validated readable paths and explicit project ownership before changing storage services.
- Validation: `pnpm exec vitest run tests/project-runtime-paths.test.ts tests/project-directory.test.ts tests/projects.test.ts --maxWorkers=1` ->45/45 PASS,10.73s.
- Outcome: Partial
- Follow-up: independent reviews, recursive checks, state/accounting contract and service wiring.

### 2026-10-25 — Capture project-local ownership requirement
- Agent: supervisor
- Changed: new working document and proposed execution phases.
- Why: User requires readable project-local runtime hierarchy.
- Validation: `rg -n 'worktrees|stateDir|dataDir|databasePath' packages/router/src/projects packages/router/src/workspaces packages/router/src/config` -> confirmed deletion hard-codes storage/worktrees.
- Outcome: Partial
- Follow-up: read-only discovery, then concrete implementation plan; no live relocation.

## Open Questions

- Supervisor: determine how shared request accounting stays reconciled while project records
  and artifacts become project-local; preserve audit history without duplicating authority.
- Supervisor: determine explicit project-directory ownership for multi-repository projects.
