# Storage ownership and service seam inventory

Worker: project_storage_discovery
Date: 2026-10-26
Scope: source-only discovery; this report is the only changed file.
Validation: source searches and reads only; no tests, live database access, source edits or commits.

## Reading this inventory

The current ordered migrations define **70 surviving logical tables**, including `brain_fts`.
The historical `pool_verifications` and `fl_key_billing` are dropped; temporary
`paid_spend_by_ref` becomes the current `paid_spend`. Migration version is SQLite user_version,
not a migrations table. SQLite may create sqlite_sequence/statistics and FTS shadow tables;
these are implementation-owned and follow their owning DB/index, never independent export units.

Codes: **P** = authoritative project-local; **S** = installation/shared; **M** = currently mixes
both and needs a split/projection; **I** = internal qualification project, distinct from user
projects. Ownership is proposed target ownership, not a statement that these tables already moved.
Every column is enumerated in Appendix A. In the main map, nonlisted columns are identity,
bounded numeric/status metadata or timestamps belonging to the same row's owner; no unclassified
table is implicitly safe to copy. Text status/error/label fields remain untrusted runtime inputs.

## Complete logical table ownership map

| Table | Owner | Content-bearing columns / references and migration rule |
| --- | --- | --- |
| tasks | P/I | spec_json/result_json/classification_json/state_reason/writable_repo; project_id scope; lease_incarnation preserves insertion identity; idempotency_key/spec_hash are local authority, not global copies |
| task_deps | P/I | task_id -> tasks; depends_on -> tasks; both must remain in same project/store |
| executions | P/I | detail_json; id referenced by members/model_requests/artifacts; retry_of is logical execution reference |
| execution_members | P/I | execution_id/task_id FKs; item_id/outcome; immutable participant attribution must survive split |
| model_requests | M | S physical accounting fields; P error_message/policy_violation/route_note/telemetry_json/web_citations_json and potentially gateway_model display strings; execution_id FK currently points to P executions; project_id ownership index |
| request_charges | M | P authoritative task-budget projection, S request accounting participant attribution; request_id -> model_requests and task_id -> tasks; incarnation/run_count pin late updates; never duplicate paid authority |
| artifacts | P/I | label/rel_path/media_type; task_id/execution_id optional logical refs; null task requires explicit owner, not installation default |
| events | M | data_json/type; task/project events P; null project/task installation events S only after typed payload projection |
| workspaces | P/I | source_path/worktree_path/dirty_paths_json/repo_alias; task_id FK; preserve source Git identity |
| meta | M | key/value are an open namespace; classify each namespace below, never copy wholesale |
| endpoints | S | data_json is provider/catalog metadata; validate/redact discovery errors and arbitrary provider strings |
| endpoint_overrides | S | data_json; installation model policy; endpoint_id logical catalog reference |
| routing_overrides | S | note is intentional installation-authored policy text; profile/tier/endpoint_id scope; do not store project prompts here |
| classifications | M | data_json keyed only spec_hash/rulebook_version, can derive project task content; move P cache or keep only explicitly sanitized structural scoring globally; current key has no project scope |
| scans | S | summary_json; sanitize external diagnostics rather than assume numeric aggregate |
| qualification_runs | I/S | detail_json P-internal run record; endpoint_id/suite_version/status aggregate may be S projection |
| qualification_results | I/S | detail_json/task_id are internal task/evidence; aggregate family/tier/outcome may be S; run_id FK -> qualification_runs |
| repository_registry | I | path/origin/alias refer runtime qualification fixtures, not user canonical projects; move with internal runtime, expose minimal registry if necessary |
| qualification_tasks | I | fixture_path/task_id/run_id/eval_id; task and run FKs; internal task payloads stay in internal project |
| paid_keys | S | enc/iv/tag/last4 are credential data; label/account_id/quota_group are installation identity; NEVER copy to project |
| paid_spend | S | request_id FK; key_ref/provider/endpoint_id + reserved/actual/cost_basis authoritative; local project spend view is projection, not second authority |
| brain_access_requests | P/I | pattern/reason/decision_reason/decided_by; project_id/task_id/job_id scope; global-target requests still originate locally |
| brain_grants | P/I | pattern/granted_by; task_id/project_id + request_id local grant authority |
| brain_files | M | path/title and index metadata; own project index P, deliberately shared global knowledge S; rebuild separate indices from proper roots |
| brain_fts | M | path/title/body FTS; full project prose must never remain in shared index after migration |
| job_state | P/I | messages_json/detail_json; task_id FK and project_id; full supervisor transcript |
| job_questions | P/I | question/options_json/answer/answered_by; task_id FK; personal/operator content |
| sessions | P/I | log_path/workspace_json/agent_label/stop_reason; task/job/session-chain logical refs; project_id; JSONL remains event truth |
| session_events | P/I | session_id FK; name/type may expose tool identifiers; payload is in local JSONL, not copied globally |
| task_contracts | P/I | contract_json/sha256; task_id FK; immutable trigger must remain effective |
| verdict_records | P/I | record_json/reviewer/qualification/revision/cache_key; task_id/audit_task_id/cached_from logical refs; global calibration only sanitized aggregate |
| verification_signals | P/I | detail_json/kind; task_id/job_id; may contain check commands/paths/evidence |
| verification_audits | P/I | detail_json/decision/reviewer; task_id/audit_task_id; do not detach audit work into user-inaccessible global storage |
| job_plans | P/I | plan_json/note/created_by; job_id FK/project_id; immutable versions and project-stamp exception retained |
| file_leases | P/I | globs_json/repository/release_reason; task_id FK/job_id; may need shared physical-repository coordination in addition to local alias locks |
| job_budget_carves | P/I | child_task_id/parent_task_id -> tasks; requests/share/depth; local parent pool authority |
| merge_queue | P/I | integration_worktree/source_worktree/branch/lock_key/commits_json/acceptance_json/detail_json; task_id FK/job_id/redelegated_to; lock and exact candidate identity |
| job_channel | P/I | text/refs_json/author_label; job/task/session refs; append-only and mirror-once triggers preserved |
| provider_slots | M/S | S physical capacity ownership; task_id/lease_owner/lease_json identify local generation; holder may encode task IDs; nonce/uncertain authority retained; no local task FK after split |
| provider_key_state | S | last_error/rate_limits_json/quota_json/plan_refusals_json can contain provider strings; retain sanitized codes/metadata only, no prompt echoes |
| provider_usage | S | scope/reservation physical key/provider/group/model usage; global quota authority |
| projects | S/P | global id/root registration plus display/lifecycle metadata S; local identity copy is manifest, not independent lifecycle authority |
| web_requests | M | P target/error/session/task ownership; S backend/key accounting aggregates; query URLs/targets must not stay installation-local |
| web_backend_state | S | last_error can echo private query/URL/provider error; sanitize; secret_fp is installation credential fingerprint |
| task_request_grants | P/I | task_id/job_id local graph refs; requests/source grant; keep with task state and local charge projection |
| budget_requests | P/I | reason/decision_reason/decided_by/role; task_id/job_id/project_id; approval and grant mutation same transaction |
| labs | P/I | root/recipe_json/repositories_json/ports_json/env_json/goal/name; project_id; env_json can contain project test secrets, never global credentials |
| lab_ports | M | global unique host port reservation S; project lab/name P display; split minimal opaque host reservation from local Lab mapping |
| lab_services | P/I | log_path/authority_json/token; lab_id FK; process PID/owner lifecycle local but physical process ownership must remain traceable across migration |
| lab_checks | P/I | result_json/repository/name/revision; lab_id FK; commands/output/evidence inside result |
| lab_events | P/I | data_json/type; lab_id FK; diagnostics can include paths/secrets |
| lab_promotions | P/I | revisions_json/targets_json/details_json; lab_id FK; exact source/target candidate refs |
| lab_teams | P/I | lab_id/root_job_id FKs; one team lifecycle |
| lab_operations | P/I | input_json/result_json/error_message/authority_json/requested_by/lab_name; lab_id/project_id; model authority must not become human operator authority |
| lab_target_locks | M | physical repository + target lock may span projects; shared minimal canonical resource digest S, full repository/target mapping P; holder_id references Lab ownership |
| task_workspace_attempts | P/I | source_worktree/repositories_json/writable_alias/submitted_commit/tree/patch_digest; task_id FK/project/session/execution refs; exact original generation |
| lab_task_attempts | P/I | checks_json/recipe_json/result_json/cleanup_error; attempt_id/lab_id FKs; recipe_digest/deadline |
| task_lab_operations | P/I | result_json/error; attempt_id FK; owner lease and cleanup result evidence |
| lab_attempt_processes | P/I | directory/logical_name/token; lab_id/attempt_id FKs; uncertain processes not cleared on metadata migration |
| request_captures | P/I | payload_json/scope_json/unavailable_reason; request_id FK currently global; private input/output never global; scope must match trusted receipt |
| task_lease_operation_keys | P/I | request_digest/id + expiration are anti-replay authority; project ownership needs join to operation scope or retained explicit identity for orphan keys |
| task_lease_operations | P/I | response_json can hold results/reasons; id FK to key; kind/request_digest; no raw copies globally |
| task_lease_operation_projects | P/I | operation_id/project_id; multi-project recovery operations require bounded fan-out or classified installation receipt; cannot assign blindly to one project |
| request_protocol_keys | M | global opaque anti-replay key S plus local private receipt key P; expiry must not resurrect dispatch |
| request_protocol | M | binding_json/reservation_json P incl task lease/budgets/key metadata; S minimal accounting/dispatch/outcome digest receipt only; request_id key FK |
| request_protocol_projects | M | minimal global request/project attribution S; local receipt scope P; request_id FK |
| worker_action_requests | P/I | value_json includes exact command/cwd/source/reason/decision/output; task_id FK/project_id/request_key; no identity-changing rewrite |
| product_deliveries | P/I | spec_json/candidate_json/evidence_json/final_decision_json; task_id FK/project_id/stage; preserve exact checked source and observation identity |
| product_delivery_history | P/I | same content columns as current delivery; task_id/project_id; trigger-created versions; immutable historical evidence must remain accessible |
| request_deletion_tombstones | S | opaque fingerprint/reservation_digest/slot_id/nonce/retired_at/expiry; prevent replay after private project deletion; no original binding payload |

## Meta namespaces, ownership and exceptional content

`storage/fair-claim.ts` stores shared project stride state in meta, read/written inside task
claim. `core/scheduler.ts` writes `worker:<owner>` heartbeat. `gateway/breaker.ts` stores
`circuit:<platform>` health records. These are S coordination records, but values must be
validated. `gateway/quarantine.ts` stores quarantine acknowledgement referencing model-request
violations; private policy text is not acceptable as global payload. An exhaustive meta prefix
search and typed namespace allowlist is required before moving arbitrary remaining meta values.
Additional inspected namespaces: `concurrency:<platform>` (gateway/capacity.ts, S),
`paid_prices:<provider>` (paid/catalog.ts, S), `catalog_version` (models/catalog.ts, S),
`provider_discovery_last` (core/service.ts, S), `claim_pass` and `claim_pass:<project>`
(storage/fair-claim.ts, S shared fairness), `brain:index-generation:global` (S) and
`brain:index-generation:project:<project>` (P). `workspaces/merge-queue.ts:withBranch`
stores process-instance-aware branch mutex ownership under
`merge-branch:<sha256(real Git common-dir identity + branch)>`; the
resource lock is shared coordination but job/lease references remain generation-bound.
`operations/lab-supervisor.ts` stores singleton `lab_supervisor_v1` lifecycle owner (S). Quarantine
acknowledgement actor/reason are installation operations content and need intentional retention,
not blind copying of a project's original violation text.
The schema permits arbitrary key/value pairs: absence of a dedicated table is not a storage
ownership exemption. Do not migrate an open-ended meta namespace by project slug substring.

Internal qualification is already named `_qualification` in `qualification/registry.ts`.
Its repositories exist only in the internal context and are registered through repository_registry.
Give it its own installation-owned **internal project directory**, not any user's project root.
Global qualification/calibration views use only sanitized aggregate facts; internal fixtures,
sessions, tasks and private response evidence remain together in that internal directory.
Discovery/probe requests with no task need an explicit installation accounting owner and bounded
operational content; they must not create unowned user project payloads.

Brain promotion is a deliberate sharing exception, not routine leakage. `brain/promotion.ts`
requires project-specific-content checks, independent model review and optional human approval.
Promotion records stay `projects/<p>/promotions/...`; approved lesson writes `global/lessons`.
Keep approved general knowledge globally, origin review/provenance locally, and global index
references that resolve without copying private source documents. Rejected candidates stay local.
Per-project brain objects currently share one brain repository/DB index; splitting physical roots
requires preserving global promotion policy and permission scope explicitly.

## Cross-ownership transactions that prohibit naive splitting

1. **Request reserve:** RequestReceipts reserve IMMEDIATE -> nested Admission.reserve checks
   local task/execution/generation/grants and shared package/key/spend, inserts model request,
   charges, paid reservation, protocol receipt; request_charges trigger stamps request project.
   Both the trigger and cross-store FKs disappear only after a replacement protocol exists.
2. **Dispatch:** RequestReceipts.beginDispatch validates local active authority and shared slot
   nonce in one transaction. A local/global split must preserve cancellation linearization and
   replay protection; a pair of async reads does not preserve that contract.
3. **Settlement:** request outcome digest CAS, request metadata, local per-task charges and
   shared paid-spend settlement currently commit together. Conservative projection replay is
   needed; task completion may not return still-unresolved liability to a parent grant.
4. **Task claim:** `TaskStore.claim` IMMEDIATE selects project/task state, dependencies, local
   file leases and global fairness stride; ClaimAdmission checks/reserves provider slots inside
   that transaction. `claimBatch` enforces same project. This needs an explicit shared-capacity
   reservation protocol when task DBs separate, not only a different TaskStore handle.
5. **Budget decisions/delegation:** `admission/budget-requests.ts`, harness budget/supervisor
   tools atomically inspect parent/child/task usage and persist budget decisions/grants/events.
   These can remain project-local if local charge/hold projections include all unresolved requests.
6. **Cancellation/lease recovery:** SqliteTaskLeases receipts and generations interact with
   task/session state; provider slots may outlive local cancellation. Global cleanup must not
   interpret missing local rows as proof an external transport or process stopped.
7. **Deletion:** `projects/deletion.ts` purges project content while retiring request protocol,
   preserving paid/model accounting, handling cross-scope captures, and quarantining slots.
   Separating DB files must replace this boundary before enabling project delete.
8. **Delivery:** ProductDeliveries validates task/project/candidate; history triggers copy every
   insert/update. All delivery rows/history and original evidence refs remain in one project
   transaction scope. Raw copies must not bypass immutable spec/candidate/decision checks.

## Validation and path-reference gaps

Observed gaps, not a complete security audit:

- `storage/tasks.ts:hydrate` parses spec_json/result_json with TypeScript casts; event hydration
  also uses raw JSON.parse. `TaskStore.get` casts SQL rows. Migration/import must validate
  WorkerTaskSchema/WorkerResultSchema plus a row schema, not rely on this existing hydration.
- `storage/artifacts.ts:get/listForTask` casts ArtifactRow; migration needs explicit validation
  of rel_path, length, hash, ownership and containment. Artifact task/execution refs lack FKs.
- `storage/usage.ts` and many admin aggregate queries cast SQL output, while SessionStore,
  ProductDeliveries, plan readers, request receipts and capture stores already use zod schemas.
  A validated project bundle does not retroactively validate every raw SQL row or JSON field.
- Many logical refs are not FKs (job IDs, session chains, audit IDs, result artifact refs,
  Lab authority JSON, channel refs). Foreign-key check alone is insufficient for export closure.
- Captured paths occur in workspace source/worktree/dirty paths; session log_path/workspace_json
  and JSONL tool/check records; artifact rel_path and contents; merge queue roots; repository
  registry and qualification fixture paths; Lab roots/repos/recipe/env/check results/service logs/
  process directory; task context repair/upstream and result evidence; delivery candidate/evidence
  JSON; action value_json cwd/command/source; brain mounts and promotion provenance. Typed current
  operational refs move; historical log prose remains historical and gets an explicit legacy label.
- Global request diagnostics, provider errors, web targets, classification cache and brain FTS
  are additional content copies even when captures/logs move. Global raw errors are not inherently
  sanitized because they came from a provider or CLI.

## Smallest next implementation: same-DB owned service handle

Implement a **same-instance bundle**, not per-project copies of TaskStore/ArtifactStore and not
new SQLite files. It introduces a selection seam without changing transaction or scheduler
behavior. Keep accounting, Gate, provider capacity and task claiming exactly as they work today.

Proposed `projects/runtime-store.ts`:

```ts
interface ProjectStoreHandle {
  readonly project: string;
  readonly db: Db;
  readonly tasks: TaskStore;
  readonly sessions: SessionStore;
  readonly artifacts: ArtifactStore;
  readonly contracts: ContractStore;
}
function bindSharedProjectStore(project: string, shared: {
  db: Db; tasks: TaskStore; sessions: SessionStore;
  artifacts: ArtifactStore; contracts: ContractStore;
}): Readonly<ProjectStoreHandle>;
```

Validate project identity (including explicit reserved internal project handling), freeze the
handle, verify all supplied DB-owning stores share the supplied connection where their public
APIs expose it. Do not invent access to private fields or change constructors merely for this
check; constructor-owner integration can enforce shared references. This is an ownership/routing
handle, **not a scoped authorization wrapper**: TaskStore still contains all projects. Calling
it a security boundary would be false. Add guarded owned-task lookup helpers later if needed.

`core/service.ts:projectStore(project)` resolves project registration then lazily caches a handle
containing its existing `this.db/tasks/sessions/artifacts/contracts`. Existing public fields remain
compatible. A new registry constructor should receive these services, not create or close them.
Service.close remains the sole owner of the existing connection. Handle reuse must preserve
identity; reload invalidates removed project handles before new work but does not relocate stores.

First caller wiring is `ExecutorDeps.ProjectDeps`: extend its shape with optional store handle
or the explicit store dependency fields. `service.ts:projectDeps` obtains the same-instance handle
and returns those fields with existing cfg/brain/access. `depsFor` already merges project deps;
its resulting dependencies must be reference-identical to current services. Do not silently
replace taskLeases/runLeases, router, Gate, web, Labs or default SessionStore per run. Existing
endSession uses `this.d.tasks`, and constructor TaskRunLeases captures `d`; those are recorded
future consumers, not invitations to make half a DB split in the seam change.

Smallest safe file brief: NEW projects/runtime-store.ts; core/service.ts store accessor/cache/
projectDeps; core/executor.ts ProjectDeps type and explicit same-instance wiring; one focused
project-store-seam test file. Public exports only if callers require them. Keep schema/migrations,
path creation, admission and scheduler unchanged. Test identity/reference stability, removed and
unknown projects, internal qualification, no new connection/files, unmodified admission receipt
semantics and existing task/session behavior. Follow with a separate typed read-routing pass over
admin callers; do not make sy.db a misleading per-project getter while global SQL still uses it.

This seam is intentionally small. **It does not satisfy project-local storage** and must never
be presented as migration or filesystem activation. Next stages still need the broker/local
receipt protocol, global-capacity claim protocol, complete meta classification and private store
relocation described above and in state-service-contract.md.

## Source search coverage

Schema inventory is derived from all CREATE/ALTER/DROP statements in storage/migrations.ts,
including the final paid_spend replacement. Appendix A lists exact surviving columns. Appendix B
lists every source file matched by case-insensitive literal SQL FROM/JOIN/INTO/UPDATE/DELETE FROM
against tasks, request_charges or model_requests. It is exhaustive for that search, **not** a claim
that dynamically assembled SQL or imports of the stores have no additional callers. Source reads
verified transaction and hydration facts named above. No database was opened or migration run.

## Implementation caller groups

- Store/transaction core: storage/{tasks,sqlite-task-leases,usage,artifacts,file-leases}.ts;
  admission/{admission,sqlite-request-ledger,request-receipts,job-pool,budget-requests}.ts.
- Runtime/authority: core/{service,executor,scheduler,supervisor-authority}.ts;
  harness/{supervisor-tools,budget-tools,worker-actions}.ts; routing/router.ts;
  scoring/classifier.ts; runners/coding/task-lab.ts. Partition accounting after same-DB seam.
- Shared coordination/accounting: gateway/{capacity,quarantine}.ts; paid/spend.ts;
  operations/{transport-recovery,daemon-status,backup}.ts. Scope queries must use broker ports
  before task state leaves shared DB.
- Project/Labs lifecycle: projects/{backfill,deletion}.ts; labs/{lab,task-attempt-source,
  task-attempt-prune}.ts; workspaces/merge-queue.ts. Old backfill assumptions cannot rerun against
  newly split stores and stamp unrelated rows as the primary project.
- Verification/internal work: verification/{audit,phase,product-delivery}.ts;
  qualification/{comparison,runner}.ts; ownership of audit and qualification tasks is explicit.
- Admin read surfaces: all admin files in Appendix B need project/runtime selection; calibration,
  dashboards/live and request evidence mix global and local facts. Keep public insights exports
  and index.ts API boundaries; panel must not bypass them to open project SQLite paths.
- Raw global writes through migration/backfill/deletion require serial integration with store
  changes. Workers editing these files concurrently would invalidate transaction review.

## Appendix A ? Exact current columns

Columns include additions from later migrations; SQL constraints and indices are in the source.

| Table | All surviving columns |
| --- | --- |
| tasks | `id`, `idempotency_key`, `spec_hash`, `profile`, `spec_json`, `state`, `state_reason`, `created_at`, `updated_at`, `started_at`, `deadline_at`, `finished_at`, `lease_owner`, `lease_expires_at`, `run_count`, `cancel_requested`, `next_attempt_at`, `writable_repo`, `result_json`, `tier`, `classification_json`, `purpose`, `project_id`, `lease_incarnation` |
| task_deps | `task_id`, `depends_on` |
| executions | `id`, `kind`, `profile`, `retry_of`, `status`, `created_at`, `finished_at`, `detail_json` |
| execution_members | `execution_id`, `task_id`, `item_id`, `outcome` |
| model_requests | `id`, `execution_id`, `purpose`, `gateway_model`, `status`, `reserved_at`, `finished_at`, `est_input_tokens`, `reserved_output_tokens`, `served_model`, `served_endpoint_id`, `served_provider`, `provider_attempts`, `attempts_exact`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, `usage_basis`, `reported_cost_usd`, `estimated_cost_usd`, `http_status`, `error_kind`, `error_message`, `cache_hit`, `policy_violation`, `telemetry_json`, `endpoint_id`, `tier`, `route_note`, `project_id`, `native_web_search`, `web_search_requests`, `web_citations_json`, `cache_creation_input_tokens` |
| request_charges | `request_id`, `task_id`, `input_tokens`, `output_tokens`, `tokens_exact`, `lease_incarnation`, `run_count` |
| artifacts | `id`, `task_id`, `execution_id`, `kind`, `label`, `rel_path`, `media_type`, `sha256`, `bytes`, `created_at` |
| events | `id`, `task_id`, `ts`, `type`, `data_json`, `project_id` |
| workspaces | `task_id`, `repo_alias`, `source_path`, `worktree_path`, `base_sha`, `source_dirty`, `dirty_paths_json`, `status`, `created_at`, `updated_at` |
| meta | `key`, `value` |
| endpoints | `id`, `data_json`, `first_seen_at`, `last_scanned_at` |
| endpoint_overrides | `endpoint_id`, `data_json`, `updated_at` |
| routing_overrides | `id`, `profile`, `tier`, `kind`, `endpoint_id`, `allow_below_floor`, `note`, `enabled`, `created_at` |
| classifications | `spec_hash`, `rulebook_version`, `data_json`, `created_at` |
| scans | `id`, `started_at`, `finished_at`, `ok`, `summary_json` |
| qualification_runs | `id`, `endpoint_id`, `suite_version`, `status`, `started_at`, `finished_at`, `detail_json` |
| qualification_results | `id`, `run_id`, `endpoint_id`, `eval_id`, `family`, `tier`, `trial`, `outcome`, `task_id`, `detail_json`, `created_at` |
| repository_registry | `alias`, `path`, `writable`, `origin`, `created_at` |
| qualification_tasks | `task_id`, `run_id`, `eval_id`, `trial`, `endpoint_id`, `fixture_path`, `evaluated` |
| paid_keys | `id`, `provider`, `label`, `billing_class`, `enc`, `iv`, `tag`, `enabled`, `last4`, `monthly_cap_usd`, `prepaid_balance_usd`, `balance_checked_at`, `expires_at`, `created_at`, `account_id`, `quota_group`, `rpm`, `rpd`, `tpm`, `tpd` |
| paid_spend | `request_id`, `key_ref`, `provider`, `endpoint_id`, `reserved_usd`, `actual_usd`, `cost_basis`, `created_at`, `settled_at` |
| brain_access_requests | `id`, `task_id`, `job_id`, `role`, `pattern`, `mode`, `reason`, `status`, `decided_by`, `decision_reason`, `created_at`, `decided_at`, `project_id` |
| brain_grants | `id`, `task_id`, `pattern`, `mode`, `granted_by`, `request_id`, `created_at`, `project_id` |
| brain_files | `path`, `mtime`, `size`, `title`, `kind`, `status`, `lines` |
| brain_fts | `path`, `title`, `body` |
| job_state | `task_id`, `messages_json`, `detail_json`, `updated_at`, `project_id` |
| job_questions | `id`, `task_id`, `question`, `options_json`, `answer`, `answered_by`, `asked_at`, `answered_at` |
| sessions | `id`, `task_id`, `job_id`, `parent_session_id`, `previous_session_id`, `role`, `agent_label`, `profile`, `tier`, `status`, `stop_reason`, `log_path`, `last_seq`, `model_requests`, `tool_calls`, `workspace_json`, `created_at`, `updated_at`, `ended_at`, `project_id` |
| session_events | `session_id`, `seq`, `type`, `at`, `name`, `ok` |
| task_contracts | `task_id`, `contract_json`, `sha256`, `created_at` |
| verdict_records | `id`, `task_id`, `purpose`, `attempt`, `reviewer`, `level`, `qualification`, `qualified`, `verdict`, `revision`, `requests`, `cache_key`, `cached_from`, `audit_task_id`, `record_json`, `created_at` |
| verification_signals | `id`, `task_id`, `kind`, `job_id`, `detail_json`, `created_at` |
| verification_audits | `task_id`, `decision`, `audit_task_id`, `reviewer`, `status`, `detail_json`, `created_at`, `finished_at` |
| job_plans | `job_id`, `version`, `plan_json`, `note`, `created_by`, `created_at`, `project_id` |
| file_leases | `id`, `job_id`, `task_id`, `repository`, `globs_json`, `mode`, `acquired_at`, `released_at`, `release_reason` |
| job_budget_carves | `child_task_id`, `parent_task_id`, `requests`, `parent_remaining`, `share`, `depth`, `created_at` |
| merge_queue | `id`, `job_id`, `task_id`, `kind`, `repo_alias`, `branch`, `lock_key`, `integration_worktree`, `source_worktree`, `source_base`, `source_head`, `commits_json`, `state`, `owner`, `attempts`, `before_head`, `after_head`, `rebased`, `acceptance_json`, `redelegated_to`, `detail_json`, `created_at`, `updated_at` |
| job_channel | `id`, `job_id`, `author_task_id`, `author_session_id`, `author_role`, `author_label`, `kind`, `refs_json`, `text`, `call_id`, `created_at`, `mirrored_at` |
| provider_slots | `id`, `platform`, `kind`, `holder`, `task_id`, `lease_owner`, `priority`, `since`, `seen_at`, `lease_json`, `nonce`, `uncertain` |
| provider_key_state | `ref`, `provider`, `last4`, `cooldown_until`, `disabled_reason`, `disabled_at`, `consecutive_failures`, `last_error`, `last_error_at`, `last_success_at`, `rate_limits_json`, `quota_json`, `selected_seq`, `updated_at`, `plan_refusals_json` |
| provider_usage | `id`, `scope`, `at`, `tokens`, `reservation` |
| projects | `id`, `name`, `created_at`, `archived_at`, `last_active_at` |
| web_requests | `id`, `call_id`, `task_id`, `project_id`, `session_id`, `kind`, `backend`, `key_ref`, `target`, `status`, `error_kind`, `results`, `bytes`, `error`, `started_at`, `finished_at` |
| web_backend_state | `ref`, `backend`, `status`, `until`, `failures`, `last_used_at`, `last_error`, `secret_fp`, `updated_at` |
| task_request_grants | `task_id`, `job_id`, `requests`, `source`, `created_at` |
| budget_requests | `id`, `task_id`, `job_id`, `project_id`, `role`, `requests`, `reason`, `used`, `cap`, `approver`, `status`, `granted`, `decided_by`, `decision_reason`, `created_at`, `decided_at` |
| labs | `id`, `project_id`, `name`, `state`, `root`, `recipe_json`, `repositories_json`, `ports_json`, `env_json`, `goal`, `created_at`, `updated_at`, `last_activity`, `creation_owner`, `creation_until`, `kind` |
| lab_ports | `port`, `lab_id`, `name` |
| lab_services | `lab_id`, `name`, `state`, `pid`, `token`, `log_path`, `restart_count`, `next_restart`, `started_at`, `owner_id`, `owner_until`, `authority_json` |
| lab_checks | `id`, `lab_id`, `name`, `repository`, `revision`, `result_json`, `created_at` |
| lab_events | `id`, `lab_id`, `type`, `data_json`, `created_at` |
| lab_promotions | `id`, `lab_id`, `state`, `policy`, `revisions_json`, `targets_json`, `details_json`, `created_at`, `updated_at` |
| lab_teams | `lab_id`, `root_job_id`, `created_at` |
| lab_operations | `id`, `lab_id`, `project_id`, `lab_name`, `kind`, `input_json`, `state`, `requested_by`, `owner_id`, `lease_until`, `result_json`, `error_code`, `error_message`, `created_at`, `updated_at`, `authority_json` |
| lab_target_locks | `repository`, `target`, `holder_id`, `lease_until` |
| task_workspace_attempts | `id`, `task_id`, `project_id`, `run_count`, `lease_owner`, `execution_id`, `session_id`, `source_worktree`, `writable_alias`, `repositories_json`, `submitted_commit`, `submitted_tree`, `patch_digest`, `state`, `created_at`, `updated_at` |
| lab_task_attempts | `attempt_id`, `lab_id`, `desired_state`, `phase`, `checks_json`, `recipe_json`, `recipe_digest`, `deadline_at`, `result_json`, `cleanup_error`, `created_at`, `updated_at` |
| task_lab_operations | `id`, `attempt_id`, `kind`, `state`, `owner_id`, `lease_until`, `result_json`, `error`, `created_at`, `updated_at` |
| lab_attempt_processes | `id`, `lab_id`, `attempt_id`, `kind`, `logical_name`, `token`, `pid`, `directory`, `state`, `created_at`, `updated_at` |
| request_captures | `request_id`, `project_id`, `scope_json`, `payload_json`, `bytes`, `phase`, `unavailable_reason`, `created_at`, `expires_at` |
| task_lease_operation_keys | `id`, `request_digest`, `expires_at` |
| task_lease_operations | `id`, `kind`, `request_digest`, `response_json`, `created_at`, `expires_at` |
| task_lease_operation_projects | `operation_id`, `project_id` |
| request_protocol_keys | `id`, `expires_at` |
| request_protocol | `request_id`, `fingerprint`, `binding_json`, `reservation_json`, `state`, `dispatch_id`, `outcome_digest`, `created_at`, `expires_at` |
| request_protocol_projects | `request_id`, `project_id` |
| worker_action_requests | `id`, `project_id`, `task_id`, `request_key`, `value_json`, `created_at` |
| product_deliveries | `task_id`, `project_id`, `stage`, `spec_json`, `candidate_json`, `evidence_json`, `final_decision_json`, `updated_at` |
| product_delivery_history | `sequence`, `task_id`, `project_id`, `stage`, `spec_json`, `candidate_json`, `evidence_json`, `final_decision_json`, `recorded_at` |
| request_deletion_tombstones | `request_id`, `fingerprint`, `reservation_digest`, `slot_id`, `slot_nonce`, `retired_at`, `expires_at` |

## Appendix B ? Literal direct SQL caller inventory

| Source file | Tables matched |
| --- | --- |
| `admin/brain-entities.ts` | tasks |
| `admin/brain-memory-manifest.ts` | tasks |
| `admin/calibration.ts` | request_charges, model_requests, tasks |
| `admin/dashboards.ts` | tasks, model_requests |
| `admin/deliveries.ts` | tasks |
| `admin/entities.ts` | tasks, model_requests, request_charges |
| `admin/insights.ts` | tasks, model_requests, request_charges |
| `admin/job-metrics.ts` | model_requests, request_charges, tasks |
| `admin/jobs.ts` | tasks |
| `admin/live.ts` | tasks, request_charges, model_requests |
| `admin/project-settings.ts` | tasks |
| `admin/projects.ts` | tasks |
| `admin/qualification-work.ts` | tasks |
| `admin/request-evidence.ts` | tasks, model_requests, request_charges |
| `admin/session-project-scope.ts` | tasks, model_requests, request_charges |
| `admin/sessions.ts` | tasks |
| `admission/admission.ts` | request_charges, tasks, model_requests |
| `admission/budget-requests.ts` | request_charges |
| `admission/job-pool.ts` | request_charges, tasks |
| `admission/request-receipts.ts` | tasks, model_requests |
| `admission/sqlite-request-ledger.ts` | tasks, model_requests, request_charges |
| `core/executor.ts` | tasks |
| `core/scheduler.ts` | tasks |
| `core/service.ts` | tasks |
| `core/supervisor-authority.ts` | tasks |
| `gateway/capacity.ts` | tasks |
| `gateway/quarantine.ts` | model_requests |
| `harness/budget-tools.ts` | tasks |
| `harness/supervisor-tools.ts` | tasks |
| `harness/worker-actions.ts` | tasks |
| `labs/lab.ts` | tasks |
| `labs/task-attempt-prune.ts` | tasks |
| `labs/task-attempt-source.ts` | tasks |
| `operations/backup.ts` | tasks |
| `operations/daemon-status.ts` | tasks |
| `operations/transport-recovery.ts` | model_requests, request_charges, tasks |
| `paid/spend.ts` | request_charges, model_requests |
| `projects/backfill.ts` | tasks, model_requests, request_charges |
| `projects/deletion.ts` | tasks, model_requests, request_charges |
| `qualification/comparison.ts` | tasks, model_requests, request_charges |
| `qualification/runner.ts` | model_requests, request_charges, tasks |
| `routing/router.ts` | tasks |
| `runners/coding/task-lab.ts` | tasks |
| `scoring/classifier.ts` | tasks |
| `storage/artifacts.ts` | tasks |
| `storage/file-leases.ts` | tasks |
| `storage/migrations.ts` | tasks, model_requests |
| `storage/request-captures.ts` | model_requests, request_charges, tasks |
| `storage/sqlite-task-leases.ts` | tasks |
| `storage/tasks.ts` | tasks |
| `storage/usage.ts` | request_charges, model_requests, tasks |
| `verification/audit.ts` | tasks |
| `verification/phase.ts` | tasks |
| `verification/product-delivery.ts` | tasks |
| `workspaces/merge-queue.ts` | tasks |

Coverage: 70 logical tables; 55 direct SQL source files.
