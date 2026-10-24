# Instagram build: MeritRouter supervised trial
Status: Active
Status detail: Worker-only build under validation; direct supervisor app edits excluded from acceptance.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Exercise MeritRouter through a complete downstream social app build; diagnose framework failures.
Paired document: D:/SwitchYardProjects/instagram-clone/docs/working/instagram-clone.md
Related: [live validation](live-validation.md), [handoff](handoff.md)

## Current State
User explicitly requires supervisor to assign and validate, never implement clone source.
Supervisor previously overstepped with direct app repairs; those remain uncommitted and are
excluded. Patch preserved under OS TEMP/instagram-supervisor-changes.patch, outside framework.
No downstream app source or runtime data belongs in this repository.
Clean worker-only acceptance checkout: D:/SwitchYardProjects/instagram-clone-worker-validation
at be26f28, containing only worker application commits integrated by supervisor. Dependencies
are an ignored junction to the initial install. Never treat the contaminated original build
as MeritRouter success. Original app has uncommitted supervisor changes; do not overwrite them.
Mode: Testing And Live Validation for clone, Editing/Iteration for authorized four-worker default.
Live execution limits changed with explicit authorization to four tasks/four repository writers;
automatic reload observed frontend and backend running together. Paid routing remains disabled.
Source schema/example/generated presets now 4/4; explicit overrides retained; file leases unchanged.
Recursive typecheck/build passed. Initial targeted42/42 and new four-writer regression passed.
Full router suite passed:119 files,1207 tests passed,2 platform skips;979.07s.
Command: `npx vitest run --maxWorkers=2 --minWorkers=2` from packages/router.
Four-worker source unit is verified; publication pending supervisor commit/push.
Worker-only clone typecheck fails TS2613 Social default-vs-named export and three TS7006 callbacks.
Independent baseline API/browser checks on8084 with DATA_DIR in OS TEMP:
- POST auth Origin=http://localhost:9999 to http://127.0.0.1:8084 returned200 and alex session;
  confirms cross-origin localhost acceptance defect.
- POST profile returned200 with raw id/username/name/bio/avatar keys, missing required user wrapper.
- Headless installed Chrome login then Explore triggers HomePage invalid element type undefined;
  confirms import defect affects real navigation, despite HTTP200 home response.
- Baseline feed screenshot captured before asynchronous feed completed; not visual acceptance.
Owned Chrome and baseline dev server stopped. Screenshots retained in OS TEMP; no app accepted.
Four bounded repair tasks dispatched on eligible free routing, each max80 requests/$0 paid.
Two repair workers made zero edits and waited repeatedly on unnecessary Linux shell requests.
Cancelled those attempts through supported CLI; replaced with explicit native-only Windows briefs,
55 requests/$0 each, within the remaining approximate budget of the original attempts.
Social replacement t_0mvlo4o0n0001cdc4db7c; backend replacement t_0mvlo4o0n41b0bab262dc.
Shell/overlay repairs continue. Worker-only acceptance checkout is now branch feat/worker-only-instagram.

## Observations and distinctions
- First frontend task t_0mvlnilss5b01f5650d07 submitted one layout file, all criteria unknown.
  It was completed/not_verified, not accepted; supervisor rejected it. Worker quality failure,
  not evidence that MeritRouter falsely accepted completion.
- Replacement t_0mvlnoy8f48c075104735 pinned minimax-m2.7 got HTTP402 not-in-plan;
  failed gateway_not_in_plan without paid fallback. Correct free-plan enforcement.
- Frontend split tasks t_0mvlnptqxaa149cc06c8b (shell), ...0425ebaa79eb (social),
  ...5ecbd1137ba5 (overlays) returned implementations. Integration defects remain.
- Backend t_0mvlnilssaf0186e3f733 exhausted100 requests across T2/T3, acceptance unmet;
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

## Open Questions
No product change beyond four-worker defaults authorized by this trial alone. Record framework
findings separately from worker-quality failures and obtain scope before broad framework fixes.
