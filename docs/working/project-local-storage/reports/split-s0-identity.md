# S0 split-store identity prerequisite

Worker: storage_split_contract
Date: 2026-10-26
Status: implementation frozen; supervisor review and integrated checks pending.
Directory: MAIN D:/SwitchYardRouter after supervisor consolidation; original isolated-phase evidence below is historical.

## Changed files

- Appended exactly one entry to storage/migrations.ts; prior entries unchanged.
- Added projects/store-identity.ts and storage/store-role.ts.
- Added tests/project-store-identity.test.ts and this report.

## Behavior

New strict zod DTOs define versioned coordination/project role identities, lowercase UUID
installation/project/store identities, positive store generations, registration lifecycle and
opaque migration journals. Constructors mint new project and store UUIDs, so a recreated slug
does not inherit the deleted project's immutable identity. A bound manifest is immutable;
opening/asserting another role, owner or generation fails rather than replacing it.

The additive tables are store_identity (one manifest), project_store_registrations (global
registration metadata) and project_store_migrations (opaque migration identity/checkpoint
metadata). The live-slug unique index applies only to non-retired registrations; retired UUID
records remain. A second unfinished journal for one project is prohibited. Source/target store
IDs differ and target generation must be source+1. Added logical tables bring the prior 70-table
inventory to 73; classify manifest by its role, registrations/journals as global coordination.

Registration helpers require an already-bound coordination identity and matching installation.
Registration is idempotent only for the same immutable project/store/generation/root; it cannot
overwrite an existing owner or reuse a retired UUID. Explicit retirement is generation-bound
metadata CAS and refuses a migrating record. It is not a task-cancellation, payload-deletion,
dispatch-fencing or accounting-retirement implementation. Those remain lifecycle integration.

Project-role initialization/assertion requires synchronous=FULL, exact immutable identity,
only own/nonempty task project IDs, no foreign projects rows, no rows in named credential,
provider, paid/global coordination tables, and only the currently classified project-local
brain index meta key. Unknown/shared meta rows fail closed. This conservative whitelist needs
explicit expansion as split callers are implemented; it must not become an arbitrary copy rule.
Role initialization runs in one IMMEDIATE transaction; refusal preserves rows and no manifest
is left behind. Post-bind assertions recheck contents and FULL rather than trusting old checks.

Legacy openDatabase is unchanged. Opening a legacy NORMAL store applies additive schema only,
does not bind any role, and remains NORMAL. No helper opens a store, chooses a default path,
constructs project services or activates split runtime behavior. Directory registration uses
the existing pure validated projectRuntimePaths contract; physical path authorization remains
the later registry/migration owner's job.

Journal read validates persisted scalar DTOs, installation ownership, registered project
identity and generation-shape rules. This phase does not implement journal creation workflows,
state transitions, store generation switching, migration effects or reconciliation authority.

## Validation observed

- Initial focused run: 9 PASS / 2 FAIL of 11, 3.91s. Both failures were fixture string IDs in
  existing INTEGER PRIMARY KEY provider_usage/paid_keys schemas. Fixture setup now lets SQLite
  generate IDs; production schema and assertions unchanged.
- Corrected focused run: 11/11 PASS, 3.99s.
- Final additional pre-bind preservation and pending-journal uniqueness cases:
  `pnpm exec vitest run tests/project-store-identity.test.ts --maxWorkers=1`
  -> exit0, 12/12 PASS, 3.69s (3.096s tests).
- Covers previous-schema upgrade, preserved legacy rows/NORMAL/unbound role, reopen stability,
  wrong role/owner/generation, pre/post-bind task contamination, shared credential/provider/
  spend rows, FULL downgrade refusal, registration idempotence and slug recreation, malformed
  persisted/runtime DTOs, migration DTO reads and unfinished-journal exclusivity.
- `git diff --check` for owned source/tests -> exit0 before final report.
- No broad typecheck/build ran because other authors are editing disjoint source files;
  supervisor owns those checks after all source freezes.

## Limits / unchanged authority

This is S0, not a physical store split, request broker, service registry, dispatch fence,
migration, deletion or backup implementation. The shared-table allow/deny classification and
project ownership guard do not replace the later full export closure and direct-SQL caller
audit. Existing legacy shared stores can still contain project data because no service uses
these new role APIs yet. No existing index/public API export or caller changed.

Only disposable temp SQLite fixtures were opened. No live DB/config/project/provider/Docker
operation, source reference copying, new checkout, drive-root directory, shared-document edit,
commit or push was performed. Temp DBs were closed and their owned fixtures removed.

## Main-checkout role classification hardening

Supervisor consolidated all files into MAIN after the user prohibited repository metadata
directories. This worker resumed only in MAIN; no old checkout was opened or recreated.

The original denylist omitted the genuinely shared request_deletion_tombstones table. It is
now denied in project-role stores. pool_verifications and fl_key_billing are historical dropped
tables, while paid_spend_by_ref was renamed to the already-denied paid_spend; none is a current
local projection. Restoring any of these dropped names is now an unknown-schema refusal.

All 73 current logical tables have explicit role classification. Project-role preflight rejects
unclassified/restored/extension tables even when empty, or missing classified tables. Only the
exact real brain_fts shadow-table types are exempt; a prefix match is not sufficient. New
migrations must update this classification in the same unit before project-role activation.

qualification_runs/results, repository_registry and qualification_tasks are permitted only
in the reserved _qualification project. Full user-project review/audit tasks remain ordinary
project-local task/evidence records, not a reason to copy internal qualification tables.
model_requests/request_charges, request_protocol/keys, classification/brain/web and Lab tables
remain local or mixed-to-local projections. They are not shared provider/quota/spend authority;
future broker/global usage and port-grant tables remain separate shared services. Existing
direct project_id-bearing private rows now require the exact nonempty owner slug as well.

Text-only edits added seven meaningful cases: shared tombstones, four restored/unknown table
names, qualification isolation and foreign direct-owned event data. Focused validation is
paused at the supervisor's request while old native-cache cleanup occurs. No tests/build/
typecheck/native process ran during that pause; prior 12/12 results do not certify this edit.

Supervisor authorized focused testing to resume in MAIN. Final strengthened command:
`pnpm exec vitest run tests/project-store-identity.test.ts --maxWorkers=1`
-> exit0, 19/19 PASS, 5.43s (4.583s tests), MAIN packages/router on 2026-10-26.
No S1 edits or broad typecheck/build by this worker. Strengthened source and report frozen.
