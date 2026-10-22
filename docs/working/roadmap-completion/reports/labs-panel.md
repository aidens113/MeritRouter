# Labs panel worker report

Status: Implemented; focused tests, router/panel typechecks/builds, real demo seed, legacy production acceptance and Labs production HTTP/browser acceptance passed. Final browser promotion-detail click rerun passed; frozen for supervisor integration verification.

## Intended ownership

New admin/labs.ts facade; new panel /p/[slug]/labs list and /labs/[name] detail; client Labs controls/recipe editor; /api/labs routes with explicit project scope; navigation Labs entry; project settings recipe section; job form/API lab selection; project overview Labs row; demo fixtures and focused tests. Root owns insights/live/service/CLI/export shared files. No accounting-worktree changes.

## Boundaries

Explicit human actions enqueue LabManager.requestControl only, never start a model worker or launch services on page reads. All lookups require configured project scope; archived writes denied. Status uses publicStatus and operation projection, never serializes raw manager/store records. Supervisor approved human command editing as authored config; recipe.env names only, values preserved server-side. Materialized env/service tokens never cross status/operation APIs. Runtime checks/logs are bounded and redact configured env values/current tokens plus historical fixed-width tokens.

## API dependency findings

L2 LabManager supplies publicStatus/requestControl/operation/control queue; raw controls result can carry full LabStatus, so public facade must omit results or project safe fields. publicStatus strips lab.recipe/env and service.token/owner_id; queue ownership display requires safe owner-state API or facade scoped store-derived booleans. Existing project settings write helper likely handles lab/labs once ProjectConfig schema supplies them. Jobs startJob lab contract pending supervisor merge.

## Verification

Frozen offline installation passed (7m36s, 219 cached dependencies; expected missing dist CLI shim warnings before build). node --check passed for seed-demo.mjs and new validate-labs.mjs. No meaningful dependent typecheck/build/test run yet; no live quota or user data.

## Implementation draft

New facade APIs: labsListView, labDetailView, labLogs, labRecipeView, saveLabRecipe, requestLabControl and HumanLabControlSchema. Explicit writes ensure only the Labs supervisor and enqueue human:panel controls; launcher failure is actionable HTTP409. Pending creates remain visible through project-scoped operations before a lab exists. Controls validate declared service/check names before supervisor launch. Supervisor authorized legacy conversion in this facade: explicit human Save recipe validates first, migrates only the original raw repositories under the same project slug together with lab/labs, preserves other global settings and project rows, and writes through the prepared/snapshot-guarded path. Legacy recipe view is read-only only when archived. UI explains that Save enables Labs without adding a placeholder project. A preservation regression is drafted.

Panel list/detail includes live subscriptions, service ownership, declared checks/results, bounded on-demand logs, persisted queued/running/failed operations, promotion review reason and destroy/refresh confirmations. Project settings Lab recipe tab preserves private env values; jobs have an optional ready-lab selection and project overview links Labs.

Demo seed creates two real HTTP fixture labs in demo-only ports56200?56300, queues start/check operations, validates real health evidence, records reviewed promotion, and stops services finally. No fake running rows.

Draft tests: admin-labs tests project scope, explicit queue-only launch, no launch on reads/editor save, env/token redaction, human recipe preservation and invalid repository/archive/model actor refusal. validate-labs.mjs starts owned production Next and unique headless browser, exercises pages/APIs/lifecycle queue, lab job binding without a model worker, captures16 Labs desktop/phone light/dark screenshots plus2 focused-tooltip screenshots, and stops daemon via CLI supervisor-stop plus owned panel/browser finally. These are not passing claims until executed after dependencies merge.

User-reported blank Verification tab acceptance added to the production harness: select an existing demo task with no contract/verification/importance metadata, request ?tab=verification and require the visible Contract and verification heading plus No contract yet explanation. Root owns the corresponding task-detail fix; no task-detail/model page edits here.

User-reported Team metrics tooltip acceptance also drafted: actual CDP mouse opens seeded multi-agent job Team tab disclosure, verifies hovering container shows0 tips, hovering one icon shows exactly its own tip, actual Tab focus shows1 and blur/leave shows0. Desktop/phone viewport overflow checked with2 extra screenshots. Root owns the HelpTip group-name fix; no HelpTip/metrics source edits here. No passing browser claim yet.


## Validation checkpoint 2026-10-22 13:05 PDT

Implemented and production-validated Labs list/detail, explicit human controls, scoped APIs, bounded logs and check evidence, authored recipe editor/private env preservation, same-project legacy migration, project navigation/overview, and optional job lab binding. No worker/model starts from these controls.

Promotion history uses validated scoped metadata only; explicit Inspect promotion evidence fetches one completed promotion through manager.publicOperation and projects bounded checked heads/targets/check summaries/manual git commands/conflict paths. Arbitrary result properties/raw errors/runtime env never reach the client. Manual commands are intentionally public promotion instructions and never executed by the panel.

Found/fixed during actual production checks: Next rewrote module-relative CLI into cli.<hash>.js and launcher incorrectly chose it. Authorized operations/lab-supervisor.ts patch prioritizes explicit environment, real cwd installed/checkout dist, then only module-relative basename cli.js. Real production launch with no CLI override now works. Also creation persists a row before port allocation: facade now returns status:null plus persisted operations during creating, avoiding unresolved placeholder materialization. Core publicStatus still does not support partial creation; reported separately to supervisor, no core change.

Observed passing: focused admin-labs.test.ts 8/8; router and panel typechecks; router build; production panel build; demo seed with two real HTTP labs/checks/promotion, stopped finally; separate production legacy migration HTTP acceptance (4498) preserves global values/repository paths/project identity/exact row and creates no model requests/daemon; full production validate-labs.mjs acceptance (4496,CDP9369) passes all lifecycle controls, scoping/archived/malformed400 cases, manual prepared-promotion evidence, job lab binding without worker, no model requests, live subscriptions, Verification no-metadata explanation and actual mouse/keyboard HelpTip regressions. 18 screenshots captured, desktop detail/light and phone recipe/dark visually inspected; no horizontal viewport overflow at1440/390. Final rerun additionally clicks promotion evidence in browser.

First passing run owned panel23516 Chrome23016 daemon21708; fixture web56203, service PIDs92/22600. All stopped in finally, lease verified null and seeded labs stopped. Earlier failed create left one stopped panel-check fixture, subsequently service-stop/destroy cleaned it; no filesystem deletion/PID killing used. Later final rerun process inventory is in labs-browser-validation.log.

Supervisor-owned edit included in this tree: admin/insights.ts exports ./labs.js. No commits/push/shared working doc edits. Root full suite/integrated package remain supervisor validation; this worker makes no full-suite claim. Local logs are evidence artifacts, not source; .demo screenshots/data remain ignored.


Final production rerun passed exit0 including real browser click Inspect promotion evidence and visible manual git instructions. Final owned panel22760/Chrome17992/daemon23164; fixture web56202/PIDs2780,2480. Finally stopped all processes; no model requests added. git diff --check passed (line-ending normalization warnings only). Exact source is now frozen for root independent acceptance; no commits/push.
