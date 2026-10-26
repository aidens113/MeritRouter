# S4b staged project runtime registry

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; supervisor broad checks/review pending.
Directory: MAIN D:/SwitchYardRouter only.

## Owned implementation

- projects/runtime-registry.ts opens only existing registered project-role stores and owns
  pinned actual runtime bundles and close/drain sequencing.
- projects/runtime-services.ts is the explicit constructor factory for one complete local
  TaskStore/Admission/ProjectRequestLedger/Gate/TaskRouter/SessionStore/ArtifactStore/
  ContractStore/Executor/task lease graph per project. Global catalog/providers/paid spend/
  broker/grants/health are explicit shared inputs; local privateServices callbacks are required.
- projects/runtime-store.ts adds explicit split identity handle and exact local task/run checks;
  old same-DB handle remains legacy. No core/executor.ts or run-sessions.ts modifications were
  necessary: a whole local Executor owns every this.d store and TaskRunLeases/end-session path.
- core/service.ts adds staged createProjectRuntimeRegistry and shutdown drain only. All bundles
  in this factory share one separate ProviderHealth over existing shared providers; the already
  attached legacy health is never rebound. Requires bound coordination DB and quiescent legacy
  worker/task state; no default getter, queue or projectDeps activation is changed.
- Explicitly extended storage/db.ts fileMustExist+expectedIdentity options default to legacy
  behavior when omitted. Existing-only skips mkdir and uses SQLite fileMustExist; expected role
  is verified on the opened connection before writable pragmas/migration. No duplicate migration
  engine. Open failure closes its connection. New project-runtime-registry.test.ts and this report.

## Stable API and authority

ProjectRuntimeRegistry(coordinationDb,{context(slug),build(input),forbiddenProjectDirectories?})
exposes openRegistered(projectUUID),forSlug(slug),forLease(exact LeaseRef),loaded(),close().
Only registered state is accepted; missing/retired/migrating/ambiguous contexts fail. No
provisioning, fresh-store fallback, role initialization or migration approval is implied.

Construction input contains pinned identity,cfg,paths,db,assertCurrent(). Bundle exposes actual
local stores/admission/ledger/Gate/router/Executor/brain/access/taskLeases, tracked runSingle and
runBatch, assertCurrent and drain. Context storageDir is project/.MeritRouter/state; brain path
is project/.MeritRouter/brain. Session/artifact constructors use project/.MeritRouter root so
files are siblings sessions/artifacts, not installation directories or extra state nesting.
Local own projects lifecycle row is initialized from identity.slug/configured project name;
this is required by request-capture scope validation and never copies task graph globally.

Registration UUID/store/generation/path and configured slug/directory must agree. Before writable
open, existing runtime ancestors/file must be ordinary physical paths, not symlinks/junctions,
and the role manifest must match. The database must have exactly one hard link. A cached bundle
pins dev/ino/birthtime; lookup and Executor/Gate entry revalidate registration, physical paths,
file pin and role. Factory wires root Gate assertRuntime at entry and immediately pretransport,
so a file change after durable intent cannot cause transport. A cached connection is never used
as justification for silently returning a replaced file. Normal migration must drain first.

Each bundle has its own actual Executor and TaskRunLeases. Execution entrypoints validate exact
project/incarnation/run/owner and are tracked even when invoked through the Executor object;
foreign task batches cannot substitute a root/global fallback. Registry shutdown refuses new
opens, aborts local executors, waits executions/reports/Gate/accounting, then closes local DBs.
The coordination DB remains open until the service's later shutdown. Drain failure leaves the
corresponding database open and surfaces an error; it is not reported as a clean close.

Staged service method requires grants,broker,executionGrants and privateServices callbacks.
No implicit root Brain/promotion/supervisor service callback is installed. It rejects source
checkout project directory, active legacy work, wrong/unbound coordination and a second staged
registry. The later queue/operations adapters must explicitly choose returned local bundles.

## Validation

- First actual two-project runtime graph:11/11 passed before final boundary additions.
- Added an actual Executor fake-provider run through local lease settlement and session end;
  fixture uses valid WorkerOutput and current fake clock matching model checkedAt (a future
  fixture clock initially excluded stale model evidence; no product freshness rule was changed).
- Final native runtime16 +root Gate5:21/21 passed21.84s. Includes private request/session isolation, inflight close,
  staged service composition, missing files/parents, wrong role before migration, hardlinks,
  junctions, cached generation/path/file replacement, and foreign task entry refusal.
- Windows blocks rename of open SQLite files with EBUSY. Cached-file replacement test first
  attempts it; on that exact Windows failure it closes the fixture connection, replaces same
  path natively, then requires cached lookup and executor entry to detect changed file identity.
  This is an accidental-relocation fence, not a claim of hostile OS sandboxing or open-handle
  replacement capability on Windows. OS-temp fixture data only, fake providers, no live calls.
- Supervisor owns independent source review, recursive typecheck/build, integration and commits.

## Remaining phases

This is staged composition, not final runtime activation. S5 must route real claims/heartbeats/
executor start through these bundles and exact execution grants. S6/S7/S8 must scope private
Brain/Lab/admin/CLI/MCP operations and internal synthetic stores before S9/S10 activation and
migration. Existing registered missing volumes fail closed throughout. No user data was moved,
no source .MeritRouter or new checkout was created, and no provider quota was spent.

## Review correction: installed package versus source checkout

The staged factory no longer forbids a blind four-level module ancestor. New specifically named
projects/source-checkout.ts infers a source checkout only for module layout
<root>/packages/router/{src|dist}/<area>/<module> plus a validated root package.json name
meritrouter-workspace. Ordinary npm installation under <project>/node_modules/meritrouter
never makes the consumer project a source exclusion, even if its package name happens to match.
Explicit host exclusions remain honored. Three regressions cover source src/dist layouts,
wrong workspace name, installed layout and invalid URL. Source is frozen; final full19-case
runtime check passed19/19 in17.93s. Existing close-result .reason predicate was already
present/correct and did not require another semantic change.

## Supervisor verification

Root independently reviewed registry physical identity/pin, existing-only pre-migration role
check, complete local Executor graph, drain ordering and staged service composition. Final
runtime19 +Gate5 =24/24 PASS18.38s. Actual private task execution/lease/session end, two-store
captures, no-hardlink/no-junction/file replacement refusal and installed package detection are
covered. Default activation, scheduler/consumer wiring and live providers remain unfinished.
