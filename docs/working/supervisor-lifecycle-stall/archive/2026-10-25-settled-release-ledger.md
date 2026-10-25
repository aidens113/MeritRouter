# Settled release ledger (historical)

### 2026-10-23 - Live stall reproduced
- Agent: supervisor
- Changed: investigation document only; denied optional node version request through supported API.
- Why: supervisor had no plan and no implementation, waiting on unnecessary host command.
- Validation: CLI job read -> running,16 requests, cancelled env-inspect child; last tool npm run typecheck.
- Outcome: Partial
- Follow-up: trace and repair lifecycle progression rather than approve needless checks.

### 2026-10-25 - Resume and implement lifecycle correction
- Agent: supervisor
- Changed: assigned disjoint lifecycle and loop-role workers; no app code edits.
- Why: confirmed PlanStore supports undispatched nodes, but plan_work couples recording and execution.
- Validation: CLI job -> cancelled22requests, both children cancelled; source inspection confirmed current gaps.
- Outcome: Partial
- Follow-up: draft plan support, command/dispatch gates and bounded discovery; independently validate.

### 2026-10-25 - Integrated lifecycle correction verified
- Agent: supervisor
- Changed: worker-owned lifecycle/loop/planning/storage/charter files and proportionate regressions; docs/roles.
- Why: require persisted planning and actual assignment before unrestricted discovery/execution.
- Validation: pnpm -r typecheck and pnpm -r build -> exit0; full vitest ->1392pass/9fail/3skip,525.41s.
- Validation: all8failedfiles serialized ->62/62,299.72s; final7-file delivery/native/harness selection ->49/49,42.59s.
- Outcome: Accepted
- Follow-up: publish verified source, restart bounded free-only pilot and inspect actual plan/dispatch; no clone accepted.
### 2026-10-25 - Live encoded-plan regression corrected
- Agent: supervisor
- Changed: worker-owned lifecycle guard and regression; preserved encoded-array compatibility.
- Why: pilot t_0mvo5uxr4cfd4c54aca73 persisted spec/prepare but failed18requests before any plan/task.
- Validation: independently observed final4-file lifecycle/loop/team run32/32,32.16s; recursive typecheck/build exit0.
- Outcome: Accepted
- Follow-up: publish correction; start replacement with425requests/$0paid, retaining failed task history and consumed quota.
### 2026-10-25 - Human-only action wait correction verified
- Agent: supervisor
- Changed: worker-owned await/action guidance and authority metadata; default human-only wait tests; Lab fixture synchronization.
- Why: live supervisor treated an impossible agent approval as repeated work and cancelled a real candidate.
- Validation: recursive typecheck/build exit0; focused75pass/1preexistingLab race in107.33s; final synchronized Lab/humanwait/clock10/10 in26.59s.
- Outcome: Accepted
- Follow-up: publish correction and390request/$0paid live replacement; preserve actual approval authority and all candidate history.
### 2026-10-25 - Runtime-owned specification binding verified
- Agent: supervisor
- Changed: worker-owned delivery tool input and new binding regressions; docs/roles.
- Why: live390request pilot repeatedly failed exact goal/hash transcription; service already owns authoritative goal.
- Validation: initial safeExtend typing failed TS2322; corrected input shape plus strict bound-spec parse. Final recursive typecheck/build exit0; independent6-file28/28 in32.28s.
- Outcome: Accepted
- Follow-up: publish and recover same live job without budget reset; request#2 denied200extra, cap390 unchanged. No app candidate accepted.
### 2026-10-25 - Phased first dispatch and working-document encoding corrected
- Agent: supervisor
- Changed: worker-owned lifecycle allowlist and real phased-dispatch regression; repaired UTF-8 working-document headings and role navigation.
- Why: after discovery cap a valid draft still could not delegate its first phase; repeated ANSI/UTF-8 rewrites had bloated ledger headings.
- Validation: independent5-file36/36 in31.44s; recursive typecheck/build exit0. Working document restored from1.1MB to17KB preserving ledger content.
- Outcome: Accepted
- Follow-up: publish and recover same390request live job; no application code authored by external FINAL.

### 2026-10-25 - Final release activated and real approval wait observed
- Agent: supervisor
- Changed: published source d9243b8; refreshed daemon8988/panel4477; scoped project oversight memory.
- Why: preserve same job/session/budget across deployments and verify real planning/assignment/approval behavior.
- Validation: live job/plan HTTP200; foundation task completed/met; deps exact npm install request pending. Root28model requests unchanged across reads while await_tasks waits for operator.
- Outcome: Partial
- Follow-up: operator must approve wa_0mvo71ilk540326de44ab in panel; then inspect install result, later implementation/review/product evidence. No app code by external FINAL.

### 2026-10-25 - Separate approval wait from bounded execution
- Agent: supervisor
- Changed: worker-owned operation clocks, recipe guidance, exact-action cancellation/caps and14regressions; docs/operations and roles.
- Why: user approved in panel after the300s operation timer had cancelled the request during human wait; replacement had changed source.
- Validation: root recursive typecheck/build exit0; full153-file run1428pass/3skip/0fail in670.58s with4workers. JSON success and newclock14/14 verified.
- Outcome: Accepted
- Follow-up: publish, reload all runtime controllers/panel, recover same390request supervisor, rebrief failed dependency phase and inspect fresh approval request. No app edits/approval impersonation.

### 2026-10-25 - Clock release activated and current install request reviewed
- Agent: supervisor
- Changed: source9995b14 published; refreshed controllers/panel; scoped recovery memory and same parent resume.
- Why: old user-reported approval was already expired, and old dependency attempts could not resume after their task deadlines.
- Validation: planv5/deps3 running; current request source matches independently computed worktree identity; requested/effective cap300000ms. Full suite1428pass/3skip/0fail remains source acceptance.
- Outcome: Partial
- Follow-up: human approve wa_0mvo8npaq640917dd768f; inspect actual install/check results and continue MVP workers. No app edits or approval impersonation by FINAL.

