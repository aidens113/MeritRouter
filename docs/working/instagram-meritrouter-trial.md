# Instagram build: MeritRouter supervised trial
Status: Complete
Status detail: Worker-only local app validated; framework findings retained for follow-up.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Exercise MeritRouter through a complete downstream social app build; diagnose framework failures.
Paired document: D:/SwitchYardProjects/instagram-clone/docs/working/instagram-clone.md
Related: [live validation](live-validation.md), [handoff](handoff.md)

## Current State
Full run/panel review: [supervisor assessment](instagram-meritrouter-assessment.md), including
all18tasks/19sessions,364physical requests, defects, limitations and prioritized improvements.
The supervised build trial is complete. User requires supervisor to assign/integrate/validate,
never implement clone source. After correction, all accepted application repairs came from workers.
Validated app: D:/SwitchYardProjects/instagram-clone-worker-validation, branch
feat/worker-only-instagram, head e28cd8f539aa74fd11ece59937c0aa75831e9f1f. Working tree clean.
MeritRouter project instagram-clone/app now points to this checkout; doctor passes and zero
running/queued tasks/jobs remain. No app source was pushed or published.
Original D:/SwitchYardProjects/instagram-clone still contains earlier uncommitted supervisor
implementation repairs. Those were excluded from acceptance and preserved, not overwritten.
A patch is in OS TEMP/instagram-supervisor-changes.patch. Do not treat that original build as
MeritRouter success. The accepted branch contains worker application commits and supervisor
integration commits; supervisor-authored planning/acceptance harness is not application code.
Dependencies are an ignored junction to the initial install; npm install supports a standalone
checkout. Run npm start in validated checkout for localhost:8083, demo alex/demo1234.

Four-worker defaults are complete: schema/example/generated presets use four worker tasks and
four repository writers, explicit overrides retained and overlapping file leases unchanged.
Live config explicitly4/4, paid disabled. Automatic reload observed concurrent app workers.
Feature commit6f9c627 published to dev/main; local/remote heads verified equal at publication.
Recursive typecheck/build and full router suite passed119files/1207tests/2platform skips,
979.07s (`npx vitest run --maxWorkers=2 --minWorkers=2` in packages/router).
Initial targeted42/42 plus actual four-disjoint-writer admission regression passed.

Worker-only app acceptance observed independently:
- npm run typecheck and npm run build pass; npm test10/10 passes with isolated temp data.
-21API contract checks and34security/concurrency/upload checks pass against production8084.
- Cross-origin login now403; duplicate case-insensitive registration serialized; ownership,
  invalid avatars/files, unique concurrent IDs, concurrent toggles, upload bytes/media verified.
- Chrome desktop/mobile: loaded media, feed/login, explore/post/comment, search/profile,
  messaging, notifications, story/reel navigation, profile edit, create/upload persistence.
- Final390px More menu: six missing actions reachable, Escape/outside dismissal, edit/logout,
  desktop unchanged, no overflow or JS errors. Screenshots retained under OS TEMP/instagram-worker-*.
- Restart retained credentials, uploaded post and profile edit.
- Some QA exact-text selectors were initially wrong for combined username/caption/comment DOM;
  corrected selectors and independent API checks proved persistence. Not application defects.
This is a local social app: stories/reels are seeded viewing/photo slideshows. Instagram-scale
infrastructure, video processing, email recovery, moderation and production deployment were not built.

Completed backend, test-type and surgical mobile tasks accepted through a fresh project-scoped
MCP client as supervisor mcp:codex-supervisor with specific independent evidence. Failed,
cancelled and rejected attempts remain recorded; no unmet task was accepted. Independent model
review was unavailable on the free plan; evaluator-change review is unimplemented, recorded below.
Temporary app servers, Chrome and owned CLI worker stopped. Authorized panel4477 remains running.
Prior manual app implementation never entered the accepted worker-only branch. Framework code
changes in this trial were limited to explicitly authorized concurrency defaults; findings below
are investigated/recorded, not represented as fixed. No paid routing or approval-policy bypass.

## Observations and distinctions
- First frontend task t_0mvlnilss5b01f5650d07 submitted one layout file, all criteria unknown.
  It was completed/not_verified, not accepted; supervisor rejected it. Worker quality failure,
  not evidence that MeritRouter falsely accepted completion.
- Replacement t_0mvlnoy8f48c075104735 pinned minimax-m2.7 got HTTP402 not-in-plan;
  failed gateway_not_in_plan without paid fallback. Correct free-plan enforcement.
- Frontend split tasks t_0mvlnptqxaa149cc06c8b (shell), ...0425ebaa79eb (social),
  ...5ecbd1137ba5 (overlays) returned implementations with integration defects; later workers repaired them.
- Backend t_0mvlnilssaf0186e3f733 had100total budget, used87physical requests across T2/T3
  (47execution/40repair; repair allowance exhausted with13initial execution requests unused), acceptance unmet;
  generated tracked tsconfig.tsbuildinfo outside declared allowedPaths. Scope guard caught it.
- MCP lifecycle inconsistency reproduced: submit_tasks/get_task_status accept project; cancel_tasks
  does not and refused Instagram task with belongs-to-project error under my-project MCP.
  CLI --project worked. Source tools.ts also binds resume_task/accept_result/reject_result to
  default project; collect_results/await_results use unscoped service methods instead.
  collect_results successfully returned Instagram result under default my-project connection.
  Treat as inconsistent cross-project lifecycle API; do not infer an access-control boundary
  breach without separately establishing intended MCP authorization semantics.
- TaskArgumentSchema omits typed budget fields; raw open schema accepts budget, but agents
  cannot discover maxModelRequests/maxPaidUsd from tool declaration. Initial constraints
  max_requests submission correctly rejected. Explicit task budget works via open schema.
- Worker backend initially requested more model budget to install dependencies despite remaining
  execution requests. Denied; this is model/tool confusion, not proven accounting failure.
- Cancellation latency: test task cancel requested00:46:04.960Z; worker action wait ended8ms
  later, but task/file lease held until00:47:03.689Z (58.729s), then cancelled on lease expiry.
  Replacement queued on that lease. Investigate acknowledgement/lease-release path; no root cause
  established yet. Other cancellation paths were not measured in this trial.
- Test-file changes elevate verification to deep only after execution, so a small bounded task
  can finish with no review reserve. evaluator_change_review reports not_implemented. Observed
  safeguards correctly retain needs_supervisor; this is a remaining validation capability gap.
- Native shell actions/checks still need human approval under actual policy. A declared npm test
  request in the tiny test repair blocked despite dependencies being provided. Supervisor ran
  exact test independently, observed9passes but7TS7006 errors and a removed projection test,
  then delegated a second correction. Its10tests/typecheck passed. No approval policy bypass.
  The first candidate's passing tests alone did not qualify it for acceptance.

## Worker Briefs
All app repair briefs are persisted in task records before execution; base pinned be26f28.
- repair-shell t_0mvlnzzlvc54f14b351bf: page/layout/globals/Feed only; named imports,
  profile/post/story/reel/create/edit navigation, follow/actions/errors and responsive layout.
- repair-social t_0mvlnzzlv23a7b7f4acb4: Social/social.css only; message compose, follow
  contract, notifications read, keyboard cards and empty/error states.
- repair-overlays t_0mvlnzzlv294231c8288a: Overlays/overlays.css only; post/user response
  wrappers, empty viewers, dialog focus, upload preview/validation.
- repair-backend t_0mvlnzzlv66b577655868: API/lib/tests plus config/generated ignore only;
  exact-origin/session expiry/atomic duplicate registration/UUIDs/profile wrapper/follow
  notification/upload DATA_DIR and signatures/storage validation/test isolation defects.
Workers never own shared working docs or commits. Supervisor integrates and independently checks.

## Work Ledger
### 2026-10-23 — Clean baseline and corrected supervision
- Agent: supervisor
- Changed: framework defaults/docs/tests; external clone worktree isolated from supervisor edits.
- Why: User clarified the app is an experiment to expose MeritRouter failures, not a manual build.
- Validation: clean checkout `npm run typecheck` -> TS2613 and three TS7006 errors; source `pnpm -r typecheck` and `pnpm -r build` -> pass; targeted Vitest42/42 + four-writer1/1 -> pass.
- Outcome: Partial
- Follow-up: Observe full router suite, validate worker repairs, trace framework issues without masking them.

### 2026-10-23 — Four-worker defaults acceptance
- Agent: supervisor
- Changed: schema/example/generated presets, operations docs and regression coverage.
- Why: Explicit user request for four workers instead of the single repository writer limit.
- Validation: `pnpm -r typecheck` -> pass; `pnpm -r build` -> pass; `npx vitest run --maxWorkers=2 --minWorkers=2` ->119 files/1207 passed/2 skipped,979.07s. Defaults/explicit overrides/presets and actual four-writer admission covered.
- Outcome: Accepted
- Follow-up: Publish coherent source unit; continue worker-only clone validation separately.

### 2026-10-23 — Worker-only app acceptance and trial close
- Agent: supervisor
- Changed: integrated worker application commits in separate downstream checkout; framework trial/handoff records and active project repository path only.
- Why: Complete the build experiment without masking MeritRouter/worker failures with supervisor implementation.
- Validation: app `npm run typecheck`, `npm run build` -> pass; `npm test` ->10/10; `APP_URL=http://127.0.0.1:8084 node scripts/acceptance.mjs` ->21pass; stdin Node security probe ->34pass; installed Chrome desktop/mobile/menu/restart checks ->pass, screenshots inspected; CLI doctor ->all checks ok,0running/queued project tasks/jobs.
- Outcome: Accepted
- Follow-up: Framework findings remain open; app source not pushed/published. Three completed results accepted as mcp:codex-supervisor; failed/cancelled/rejected results retained. Owned test processes stopped and fake test data recycled safely.

## Open Questions
No product change beyond four-worker defaults authorized by this trial alone. Record framework
findings separately from worker-quality failures and obtain scope before broad framework fixes.
