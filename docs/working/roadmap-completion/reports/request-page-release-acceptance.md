# Request page release acceptance

Status: Accepted for push and authorized panel update; deployment pending.

This isolated release is based on accepted8d22596 and includes project-isolated classification, bounded historical request evidence, original shared-batch membership proof and historical session project-scope checks. It excludes task-Lab lifecycle/caller, normalized capture migration/backend and other unfinished roadmap units. Runtime source candidate5c9deaa; later82b013d updates test fixtures to record the same durable task/execution authority real runners supply, and8ea5b43 groups authored operations guidance.

## Observed validation

- Router build, recursive typecheck and recursive production build passed before full testing. Final recursive typecheck and final recursive production build passed after fixture changes. Both browser harnesses passed again against that final build.
- First bounded full run measured779/783 in88files (362.95s): three old session-surface fixtures lacked durable authority; one separate-process test cleanup hit Windows EBUSY. These are recorded failures, not a green acceptance run.
- Updated authoritative fixtures plus historical-scope tests and real independent CLI workers passed21/21 serially (29.93s). Actual privacy refusals were preserved. Full serial rerun passed783/783 in88files (943.08s).
- Seeded demo production request harness passed8 desktop/phone light/dark captures, exact request input/parameters/response/action/file links, shared exchange deduplication, unavailable failed history, wrong-project404, legacy redirect, client navigation and related task/session/commit links. No new model requests/browser exceptions.
- Same release production historical-session harness passed8 captures, wrong-project404, page/API/all-tabs/paging refusal of mixed failed cohort, and usable same-project timeline. No model requests/browser exceptions or horizontal overflow.
- Supervisor viewed phone dark request actions and desktop light unavailable-history captures. Both harnesses stopped their own Next/Chrome;4497/9373 have no listener. Tests used only this tree's demo/temp data.

Logs are supervisor-owned temporary artifacts: switchyard-request-release-full-supervisor.log, switchyard-request-release-regression-recheck2.log, switchyard-request-release-full-serial.log, switchyard-request-release-final-typecheck.log, switchyard-request-release-browser.log and switchyard-request-release-session-browser.log.

## Deployment boundary

User authorized panel rebuild/restart for this session. Actual4477 remains prior accepted buildPID6288 until full acceptance. Config is not test data and is not modified by this release. Existing MCP process remains loaded from its old code until the client reconnects; panel restart does not reload it. Broader L5/R2 work continues separately; this release is not a complete roadmap claim.
