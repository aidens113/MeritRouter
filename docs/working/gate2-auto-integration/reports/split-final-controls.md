# Split FINAL controls audit

Status: scoped repair implemented; focused verification passed; owned source/tests frozen for supervisor review. No live mutation.

## Observed failure and cause

The supervisor reported that passive MCP `--project facebook-mvp --no-worker` returns `unknown delivery` for `t_0mvsr8qoi4c6b92cdff6b`, while project-scoped `insights.jobDetail` resolves it. I did not repeat that live call or inspect private runtime data. Source inspection explains this exact failure: `mcp/tools.ts` selects the project correctly, then `deliveryTask` reads installation-owned `sy.tasks`. Split project tasks are in `sy.projectStores(project).tasks`, so the lookup fails before candidate refresh.

All three external FINAL tools share this defect: `delivery_status`, `record_delivery_observation`, and `decide_delivery`. Additional installation-store dependencies would remain even if the task lookup alone were fixed:

- One `ProductDeliveries(sy.db)` instance serves every project instead of the selected project's database.
- Candidate refresh selects supervisor workspaces from installation `sy.sessions`.
- Lab-backed refresh uses installation `sy.labs`, rather than public `sy.labsFor(project)`.
- The human-only acceptance guard calls unscoped `sy.contract(id)`. That method resolves `stores.ofTask(id)` without a project, so duplicate IDs across stores can make a valid scoped operation ambiguous. Read the selected store's contract instead; preserve the existing guard semantics.

`service.ts` already provides public `projectStores(project)` and `labsFor(project)` ports. `admin/project-reads.ts` also supplies strict scoped store resolution and `locateProjectTask`; the latter searches only the named project when supplied, reports unavailable stores, and rejects ambiguous unscoped matches. No installation-store fallback is appropriate in split mode.

## Existing alternatives and authority

`insights.deliveryView` and `projectDeliveryReport` correctly read the selected project store. The report explicitly labels its candidate/evidence as stored and `sourceRevalidated: false`. These are useful diagnostic views, not substitutes for current-source FINAL review.

The panel's product-delivery component directs FINAL supervisors to these three MCP tools. The panel task-accept endpoint decides task execution acceptance, which is a different contract. Source search found no other external FINAL decision endpoint. Internal harness `delivery_status` reads the scoped runtime context, but does not grant the initiating FINAL role or expose an external FINAL decision alternative.

`ProductDeliveries` is publicly exported and accepts a database, but its low-level mutation methods do not perform current Git/Lab candidate refresh or the MCP human-only acceptance guard. Constructing it against `projectStores(...).db` and writing a decision would skip required service behavior. `currentDeliveryCandidate` is an internal source function, not an exported supported FINAL control. Do not use a custom script/private import or raw database writes as an operational workaround.

Conclusion: no verified existing supported path completes split FINAL status/observation/decision with the full refresh and authority checks. Keep product acceptance pending until a narrow adapter correction is implemented and verified. This conclusion does not prevent independent app testing or supported task controls.

## Minimal proposed ownership and fix

Proposed source ownership: `packages/router/src/mcp/tools.ts` only. Resolve a per-call context after `scope(named)`: selected public project store, task from that store, delivery service from its database, sessions from that store, and scoped contracts. Verify the task row belongs to the selected project and has `profile: supervise`. Obtain the Lab manager through `sy.labsFor(project)` only when needed. Pass this context through refresh and all three handlers rather than retaining a global delivery service. Missing/unavailable/foreign stores must fail closed; never search installation private rows to rescue a failed scoped lookup. No service API migration or schema change is needed.

Preserve existing controls: schema validation, current clean Git/Lab refresh, latest retained supervisor workspace, candidate invalidation, expected specification/candidate digest checks after refresh, initiator actor provenance, independently observed receipts, strict-human acceptance refusal, readiness checks, completed handoff requirement, and terminal descendants before acceptance. Keep `delivery_status`'s existing refresh behavior explicit: it may update stored candidate identity; it is not a purely passive metadata read.

Proposed test ownership: new `packages/router/tests/split-final-controls.test.ts`. Use temporary split fixtures and in-memory MCP, no provider. Seed delivery/spec/candidate and retained supervisor workspace in the selected project store; use duplicate task IDs in another project to detect global lookup leakage. Exercise all three tools through actual MCP registration. Assert selected-project status/observation/rejection and eligible acceptance succeed, foreign-project/private installation data stay untouched, explicit project overrides connection scope correctly, unknown/unavailable stores fail closed, stale candidate/spec digests refuse writes after source refresh, dirty/missing workspaces refuse review, strict-human acceptance refuses MCP, and incomplete evidence/active descendants refuse acceptance. Include a project-local Lab refresh fixture to prove the correct manager, not merely non-Lab task resolution. Retain legacy fixture coverage in `delivery-runtime.test.ts`.

Authored documentation follow-up: supervisor-owned `docs/operations.md` and shared working ledger should record the scoped FINAL behavior and actual validation. This worker did not edit them.

## Validation and limits

Read-only source inspection covered the brief's named modules, candidate resolution, ProductDeliveries guards, existing delivery-runtime tests, panel FINAL guidance and task-accept route. No tests/builds were run while the supervisor's full suite was active. No code, configuration, live stores, app source, providers, Git refs or processes were changed. Only this report was added. The live job's current candidate/readiness and actual end-to-end acceptance remain unverified by this audit.

## Authorized implementation follow-up

After the supervisor stopped broad validation and authorized the new repair brief, changed only `mcp/tools.ts` and new `tests/split-final-controls.test.ts`, plus this report. Each FINAL call now obtains the explicit project runtime stores, checks store/task project ownership, and carries its local delivery/tasks/sessions/contracts context through all three handlers. Lab refresh uses `labsFor(project)`. Existing refresh, digest, actor, strict-human, readiness, handoff and descendant checks remain in place. No service/storage API or acceptance policy changed.

Red run: original production source failed all four initial regression cases, with actual MCP `unknown delivery same-job in project beta` replacing expected success/guard errors. First green run: four cases passed. Added fifth regression creates an actual retained project-local Lab, invokes the real current journey resolver (spy observes calls without replacing implementation), and confirms all three tools receive the project-local manager, Lab and spec digest; installation Lab access is explicitly rejected. This exercises the no-browser-evidence fallback, not a passed live browser journey.

The fixture seeds duplicate IDs in two real temporary split stores, uses actual registered in-memory MCP tools and clean Git repository candidates, and does not invoke a provider. It checks explicit-project and connection-default lookup, exact candidate observations/acceptance/rejection, actor provenance, untouched other-project data and empty coordination delivery table, foreign/unknown/unavailable refusal, stale source/spec digests, dirty/missing workspace refusal, missing evidence/handoff, active descendants and scoped strict-human guard. The strict-human contract is a focused contract-store read stub; all other delivery/session/task/Git stores are real temporary fixtures. Authored shared documentation and broad validation remain supervisor-owned.

Final observed validation:

- `npx vitest run tests/split-final-controls.test.ts tests/delivery-runtime.test.ts tests/product-delivery.test.ts --maxWorkers=1 --minWorkers=1`: 3 files, 10/10 passed (58.28s).
- After moving the store identity assertion before task access and strengthening duplicate-contract/foreign-ID coverage, final frozen-tree `npx vitest run tests/split-final-controls.test.ts --maxWorkers=1 --minWorkers=1`: 5/5 passed (19.61s).
- Scoped `git diff --check` passed. No broad typecheck/build/full suite was run, per brief. Supervisor must independently verify those checks and actual split controls before live FINAL use.

No retained private state, usage, grant, task lease, application source or provider state changed. Temporary fixtures were closed and cleaned by their test lifecycle. No commit/push performed.
