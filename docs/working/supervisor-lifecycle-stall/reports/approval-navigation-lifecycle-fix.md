# Approval navigation lifetime correction

Worker: approval_navigation_lifecycle
Date: 2026-10-25
Status: Implemented in isolated worktree; runtime verification pending

## Change

Owned source: `D:/SwitchYardRouter-approval-navigation/apps/panel/app/api/worker-actions/[id]/route.ts` on `feat/approval-navigation`, based on `c77c5c5`.

The panel approval route no longer passes the HTTP request's abort signal into `insights.decideWorkerAction`. It still awaits the same decision/execution promise. No detached promise, new process launcher or background executor was added.

The existing service keeps its optional cancellation signal for non-panel callers. Its task lease/incarnation, source, policy, explicit cancellation, deadline and bounded process timeout checks are unchanged. The route retains its original strict input schema, operator-only admin surface, project lookup, pending-state guard and operation-response requirements.

This corrects the explicit browser-request cancellation coupling on the existing long-lived local panel server. It does not claim durable ownership across panel process death, changed restart reconciliation, or protection against a hosting platform terminating the entire handler. Those remain architectural limitations identified in the investigation report.

## Validation

- `git diff --check` in the isolated worktree: exit0.
- Inspected the frozen diff: only the owned route changed, removing the signal argument and adding a comment identifying the remaining executor safeguards.
- No tests were run by this worker: the parent owns a real demo HTTP disconnect regression, router/panel build and typecheck, explicit cancellation/timeout verification and panel/API checks. Main-source validation was running concurrently, so no main source or broad checks were touched.

## Return contract

Source is frozen and ready for the parent's integration/verification. No commits, app source, live state, user configuration or shared working documents changed. Only the isolated route and this worker-owned report were written. Do not treat source inspection or diff cleanliness as proof of actual HTTP disconnect survival; the parent's runtime test must establish that.

## Follow-on correction: hidden-tab live connections

The parent separately measured an approval POST waiting157478ms before request start while six persistent SSE connections occupied the origin's connection capacity. Closing four finished action tabs released the POST. This queueing issue is distinct from browser-abort cancellation and the approximately29-second recipe timeout. The parent committed the prior route correction as `868c27e` before assigning this follow-on change.

Owned additional source: `D:/SwitchYardRouter-approval-navigation/apps/panel/components/client/live.tsx` only. Hidden tabs now close the owned EventSource, clear reconnect and pending flush timers, and retain cursor/pending state. Connection creation, online handling and backoff callbacks require a visible document. Returning to visibility reconnects with the same cursor; the existing server endpoint sends catchup changes before its new hello. Tabs hidden before receiving any cursor conservatively retain a pending refresh, because a new baseline alone cannot establish which rendered data became stale.

Source callbacks check the current EventSource identity and document visibility before updating cursor, state or pending changes. Disconnect invalidates identity before closing the old source. Manual pause still controls refresh rather than task execution or visible-tab subscription; reset events and pending refresh remain subject to that pause. Existing listener cleanup remains, with disconnect clearing retries and owned source on unmount. No shared connection broker, hardcoded browser connection limit or permission UX changes were added.

Validation: `git diff --check` in the isolated worktree exited0; inspected the frozen `live.tsx` diff and the existing server catchup ordering. No broad checks or main source changes. The parent owns actual seven-tab visibility/catchup/mutation/approval and cancellation verification, plus builds/screenshots. This addresses hidden-tab connection exhaustion, not arbitrary numbers of simultaneously visible browser windows. Source is frozen for that verification.

## Supervisor verification (2026-10-25)

Final source803c3b16 includes current memory source plus both panel corrections. Offline install,
router build, panel build and post-build recursive typecheck passed. Initial cold typecheck
failed because dist was absent; building dependency first resolved it without source changes.
Demo production4488 was seeded in isolated .demo and stopped after verification;7tabs closed.

Actual HTTP/browser results: abort after execution start returned browser AbortError while
command completed exit0 in1915ms;600ms timeout produced uncertain/quiesced685ms; explicit
TaskStore cancellation produced uncertain/quiesced386ms.7Chrome tabs/6hidden retained1open
EventSource, cursor resume/catchup and actual command approval passed (queue0.4ms,total2167.4ms).
Wrong project404, already decided409, missing reason400, foreign Origin403. All fixtures
providerRequests0. Supervisor inspected1440x1000 screenshot. Evidence SHA256 manifest and
JSON receipts: C:/Users/mrjoh/AppData/Local/Temp/meritrouter-approval-liveness-803c3b16/manifest.json.

Source is integrated locally, not yet published. Primary authorized4477 now uses merged
feature build. This establishes browser-disconnect survival, not durable ownership across
panel process death. Deferred approval discoverability UX remains unchanged.
