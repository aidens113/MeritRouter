# Release scope audit

Status: Complete — source review; remaining product work identified
Owner: release-scope-audit worker
Date: 2026-10-23

## Scope and verification

Read the current working document, P0–P10 phase/acceptance tables, relevant implementation
reports, and targeted control, panel, routing, and delivery source. No tests/builds, provider
calls, runtime mutations, source changes, or commits. Existing test counts are supervisor/report
evidence, not checks independently executed by this worker. This report is the only edited file.

## Prioritized implementation gaps

1. **High: P9 attention remains task-centric and can hide unresolved products.**
   `packages/router/src/admin/projects.ts:114` (`projectAttention`) counts completed tasks with
   legacy `acceptanceStatus` of `needs_supervisor`/`not_verified`, questions, Brain requests,
   interrupted tasks, and repository problems. It never reads product deliveries. Both project
   and install dashboards consume this list and can render **Nothing needs your attention**
   (`apps/panel/app/p/[slug]/page.tsx:114`, `apps/panel/app/all/page.tsx:188`). A product attached
   to an otherwise accepted task can be incomplete/rejected without adding an attention item.
   The production QA fixture already demonstrates task **Criteria met** alongside product
   **Evidence incomplete / Not decided**; no dashboard assertion covers that distinction.
   Add scoped product attention/read models and links, independently of task acceptance.

2. **High: P9 product controls/reporting are only partially exposed.**
   The task-detail product card (`apps/panel/components/task-detail.tsx:84`) exposes stage,
   recorded readiness/decision and blocker text, but no criterion/evidence inspection or
   product observation/decision/repair controls. Existing `AcceptanceActions` posts legacy
   `/api/tasks/accept`/`reject` and does not decide product acceptance. The job page has no
   product-delivery section. MCP has genuine single-task `delivery_status`,
   `record_delivery_observation`, and `decide_delivery` (`src/mcp/tools.ts:103–117`), so an
   initiating MCP client can operate the feature; this is not an absence of backend authority.
   CLI `status` (`src/cli.ts:296`) still renders execution state/requests/goal only; CLI help
   has no product decision/status command, and neither CLI nor MCP has the planned compact
   project report aggregating delivery blockers, resource requests and next actions. P9 should
   remain explicitly partial until these operator surfaces exist.

3. **Medium: rejection changes stage but does not schedule repair.**
   `src/verification/product-delivery.ts:88` changes rejected deliveries to `validate` while
   leaving the execution task completed. The existing generic resume tool is needed to run
   the supervisor again. This is safe and documented, but the planned “rejection reopens
   delivery” experience currently requires a second command; neither product card nor decision
   result supplies an actionable repair operation. Provide an explicit authorized resume action
   or clear returned next-action instructions; do not silently spend new provider quota.

4. **Medium: default delivery is deliberately fail-closed, but quality onboarding is manual.**
   `src/routing/supervisor-quality.ts` requires fresh supplied capability evidence, and generated
   defaults contain no qualifying records. `docs/setup.md:411–470` correctly documents manual
   operator YAML entry and explicitly says ordinary qualification does not generate this
   evidence. Thus a newly configured provider/model pool alone cannot start the new default
   delivery supervisor. There is no source basis for claiming automatic frontier discovery or
   ready-to-use highest-quality routing. Keep the floor; provide an evidence-authoring/validation
   workflow and a preflight displaying which concrete record/prerequisite is missing.

5. **Medium: P8 cold large-catalog performance is below its own target.**
   The implementation report measures initial 10k-file indexing at 5,675ms, above useful
   document <2s target. Warm service/search results and actual short-document production
   navigation are strong, but do not close cold 10k/50k browser fixture and payload/query-count
   acceptance. This is an optimization/measurement gap, not an external Docker blocker.

## Phase disposition

| Phase | Source-review disposition |
| --- | --- |
| P0 | Implemented: strict spec/candidate/evidence/readiness and separate FINAL decision; actual acceptance remains supervisor-verified. |
| P1 | MCP/default/identity controls implemented; broader P9 operator parity incomplete. |
| P2 | Quality floor, routing and upward budget enforcement implemented; manual evidence onboarding limits first-run usability. |
| P3 | Native/bridge batched registry, defensive wrappers, timeouts, journals and cancellation implemented; real cross-platform proof remains separate. |
| P4 | Typed memory, authorized preferences, role/headroom injection, resume and install-root semantics implemented; source does not justify calling them unimplemented. |
| P5/P6 | Real Docker adapter and journey/runtime receipts implemented, but actual platform acceptance blocked. Automatic worker Task Labs remain explicitly unsupported; retained Labs are the implemented path. |
| P7 | Persisted spec/stage/delegation/finish gates implemented. Stages alone do not prove work happened; candidate/evidence gates provide the substantive final constraint. Repair rescheduling remains explicit. |
| P8 | Scoped indexed/lazy/CAS/memory/history UI substantially implemented and production checked; cold large-fixture acceptance incomplete. |
| P9 | Partial: legacy budgets/operations plus task-detail product summary exist; product attention, actionable panel controls, project reports and CLI parity remain missing. |
| P10 | Documentation/presets and offline integration substantially implemented; final exact-revision full-suite result belongs to running supervisor gate. Live qualified delivery pilot and physical interactive acceptance remain outstanding. |

## External acceptance blockers, not missing source

- Installed Docker client has no working configured Linux-engine pipe or approved preinstalled
  image. Consequently actual hydration/input/upload/cookie/mobile/restart journeys, network/file
  canaries, owner-crash/deadline cleanup and Chromium sandbox compatibility are unverified.
  The adapter and fake-engine tests do not certify a usable interactive runtime.
- No authorized qualified live-provider pilot ran. Request/cost reduction, usable downstream
  product quality, and the paired >=50% recovery-turn target remain unmeasured.
- Linux physical process containment is not established by the Windows checks.

Recommendation: do not label the entire P0–P10 plan complete or claim default usable product
delivery solely from a green offline suite. Close the concrete P9 gaps separately from the
environment-dependent pilot/platform gates, retaining the current fail-closed safeguards.

## Supervisor follow-through

The high P9 attention/report/job-view gaps and completed-rejection repair dead end above
were assigned and implemented after this audit. See delivery-attention-report,
delivery-status-panel and rejected-delivery-repair reports. Actual compiled CLI, production
desktop/mobile views and confirmed repair POST passed supervisor checks. Panel product
acceptance/observation remains through the initiating MCP client, preserving candidate-refresh
and CAS controls; no separate panel product-decision API was added. Manual quality onboarding,
cold large-catalog acceptance and physical/runtime/live-pilot limits remain as described.
