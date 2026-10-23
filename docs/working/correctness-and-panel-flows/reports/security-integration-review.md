# Security integration source review
Outcome: Partial - two lifecycle follow-ups reported to supervisor
Date: 2026-10-23
Owner: repeat-handling independent review worker
Scope: Actual model-facing enforcement and supervisor/operator authority, read-only source review.

## Findings requiring integration review

### R1 - P1: Tool batches can outlive their captured task authority
- Source: harness/loop.ts:281,314,361; runners/types.ts ask() checks lease around model calls.
- Trigger: one model response contains a long await followed by a file/brain/channel edit or terminal submission. Cancellation or lease generation loss occurs during the awaited first tool.
- Current loop checks signal at the next model request boundary, but does not check captured lease/signal before each subsequent tool or before onResponse attribution commit. Repository edit tools perform path checks, not lifecycle authority checks.
- Consequence: stale task generation can still edit its repository and write managed state after authority loss. This is a lifecycle issue, not an arbitrary outside-path bypass.
- Suggested fix: trusted captured-lease/signal assertion before each tool (including terminal), after awaited operations when subsequent effects follow, and before attribution commits. Apply equivalent guard to resume tool replay/reconciliation.
- Validation: source-confirmed, no cancellation fault injection or test run during this review. Sent immediately to supervisor.

### R2 - P2: Direct supervisor network/Lab calls have only an initial policy check
- Source: harness/outside-operation.ts:7-14; harness/web-tools.ts web.search/web.fetch; labs/tools.ts make wrapper then manager.control/http.
- mediateOutsideOperation validates the captured lease and current policy, then returns null for an authorized supervisor. The later service call receives ctx.signal but no reload/authority monitor equivalent to executeSupervisorCommand's monitor.
- Trigger: security.outside_repository becomes disabled/human_only or lease authority changes while an asynchronous/queued Lab or multi-attempt web operation is pending.
- Consequence: later physical effects may proceed under stale initial authorization until normal cancellation propagates. Existing ctx.signal correctly carries ordinary task cancellation; this finding specifically concerns policy revocation and authority revalidation between asynchronous phases.
- Suggested fix: share a supervisor authority guard/abort scope with services, or revalidate immediately before queued physical effects. At minimum do not claim active policy revocation for network/Lab paths without acceptance coverage.
- Validation: source-confirmed difference from broker/direct shell monitoring; no Lab/browser/provider operations. Sent to supervisor.

## Fixed while integration review was in progress
- ExternalCodingRunner originally exempted the profile string supervise and launched arbitrary processes without checking disabled/human-only policy. Latest runners/coding/index.ts unconditionally refuses external autonomous workers. Source confirms the reported conditional bypass is closed.
- runTaskLabChecks originally exempted supervise by name only. Latest task-lab.ts requires supervise profile, configured supervisor mode and supervisor host policy before direct path. Worker path files an action, never starts a Lab, and never treats a supervisor response as durable check proof.
- Broker supervisor approval and executeSupervisorCommand now also require configured supervisor mode. Source confirms these checks; no worker test claim substituted for inspection.
- Known direct integration after_integrate Lab call was already assigned to supervisor; deliberately excluded from duplicate discovery.

## Enforcement confirmed from source
- Worker generic command and declared-check paths use WorkerActionRequests; coding post-submission checks and targeted review checks use the same authority path. No unsandboxed external-worker fallback remains.
- Requests persist validated command/cwd/source/lease/project/task/action data. Broker limits requests, checks owning supervisor and original worker generation, rechecks after source-identity awaits, durably claims running before spawn and marks failures uncertain. Replay of decided actions does not spawn again.
- Current disabled/human_only/supervisor policy is reloaded from trusted config; human_only rejects model supervisor approvals. Operator identity comes from server adapter, not HTTP body.
- Panel approval body is strict, request/project is resolved before decision, token login gate is used when configured, mutation proxy rejects cross-origin requests. Optional-token local panel remains an explicit local operator trust boundary; this review did not treat unrelated local processes as sandboxed workers.
- Generic repo path normalization rejects absolute/traversal/reserved NTFS/git metadata syntax. Edits refuse final symlinks/hardlinks, check canonical ancestor confinement and protect the trusted config path. Native tools cannot create links or edit Git metadata.
- Git process policy disables hooks/fsmonitor/global/system/env config redirection and rejects executable local filters/merge/trailer/diff conversions. This rules out the initially suspected native commit-hook bypass. Few synchronous metadata Git reads now use the same policy.
- Artifact scoped reads validate task/project grants and canonical artifact root before bytes and verify stored size/hash. Explicit supplied upstream references verify declared dependency ownership. Managed brain/channel/artifact operations are fixed scoped capabilities rather than arbitrary filesystem access.

## Limits and validation
- This was source review only. No broad tests, providers, live state, user data, process starts or product/test edits.
- Request source identity covers HEAD, tracked diff and untracked nonignored source, not a fully immutable OS/dependency snapshot. Approval executes a bounded trusted host action, so approved shell behavior is outside the worker sandbox by design. Source/evidence wording should retain that practical boundary.
- Supervisor owns follow-up edits and frozen acceptance. Report is the only file authored by this review.

## Final broker/browser review and correction

Reviewer: worker-containment. Scope: read-only lifecycle/browser review, followed by supervisor-authorized
narrow correction of the concrete freshness finding below. No broad tests, providers or live configuration.

### R3 - Corrected: default human-only supervisor checks could reuse old approved output

`executeSupervisorCommand` previously omitted logical invocation identity when filing human-only actions.
After check -> runtime/service progress -> same check with unchanged repository source, the loop correctly
allowed a fresh check but the broker returned the old completed action. A new check artifact/calibration
timestamp could therefore wrap old stdout without a second approval or physical command.

The helper now accepts/forwards trusted invocationId. Supervisor tool checks use env.toolInvocationId;
integration checks use persisted item/attempt/check-index identity; final job checks use execution/check-index
identity. Same logical replay remains deduplicated, while a new logical check requires new operator approval.
Repeat worker owns the two generic tools.ts helper calls and was notified to forward trusted identity there.

Focused validation: `npx vitest run tests/worker-containment.test.ts --maxWorkers=1 --minWorkers=1`
passed12/12,11.53s. New regression performs two actually approved host commands at identical repository
source, separated by an external temporary runtime-state change; physical counter proves exactly two runs,
fresh stdout proves the second observation, and same-invocation replay adds no third execution.

### Current enforcement verified from source

- Browser worker-action POST accepts a strict body without actor fields; lookup is exact project+request,
  stale/decided requests return conflict and the server supplies fixed operator identity plus trusted config.
  `disabled` refuses approval/response, `human_only` refuses model-supervisor approvals, and current policy
  is reloaded before execution and throughout running broker commands. Browser request cancellation flows
  into command cancellation; uncertain effects never become successful or automatically replay.
- Proxy protects mutations using browser Origin/Host and cross-site checks plus configured token session;
  route requires JSON. Headerless local API clients remain the established explicit local-operator boundary,
  not a new model-role permission. No model tool accepts operator identity from model arguments.
- Worker Task Lab path persists an escalation then stops before ensureLabsSupervisor/register/start; a
  supplied supervisor report cannot become durable attempt proof. External coding launch always refuses.
  Automatic real Task Lab success for workers is intentionally unsupported under this containment model.
- Queued retained-Lab controls preserve captured task authority and current policy across daemon dispatch,
  setup/check/service starts, promotion Git effects and later backoff/recovery. Model promotion cannot
  impersonate human/auto. HTTP receives the original cancellation/authority signal through ownership waits
  and network/body processing. Human-origin services are excluded from model revocation rollback.
- R1/R2 have corresponding root per-tool authority guards and live outside-authority scopes; their broader
  regression acceptance belongs to supervisor. This review found no further concrete model-facing bypass
  in the inspected broker/browser routes.

Source frozen after the correction. Supervisor owns integrated build/full/browser acceptance.

## Post-suite compatibility correction: configured supervisor profiles

The schema's temporary exclusive name/mode binding rejected existing supported custom supervisor profiles
(for example inspect configured with mode supervisor). Restored compatibility while retaining the reserved
supervise profile's supervisor-mode requirement. Supervisor authority now comes from one shared
`core/supervisor-authority.ts` predicate: validated original LeaseRef, current persisted task state/project/
owner/generation/incarnation/expiry/deadline, persisted profile/spec agreement and freshly reloaded trusted
profile mode. Model role text and forged context profile cannot establish supervisor privilege.

Applied the predicate to broker decisions, direct supervisor commands and their monitors, generic network
eligibility/scopes, queued Lab authority, integration workspace eligibility, supervisor request lists, generic
command/check branches and the Task Lab helper gate. External autonomous runners remain disabled. A custom
supervisor loses host authority immediately when its configured mode changes, even if its in-memory config
is stale; human-only still requires operator handling and disabled still refuses outside actions.

Focused acceptance:
- worker-containment13/13 and outside-operation10/10 passed during initial compatibility run. Added final
  custom child-action broker approval/revocation regression; custom authority2/2 isolated passed3.69s
  (containment now14 total). Positive tests use current trusted custom supervisor configuration; negative
  tests forge role/context profile over a persisted worker and prove no elevation.
- labs-scripted1/1 passed17.94s. Fixture explicitly enables supervisor host policy for its temporary bound
  supervisor and uses exact declared-command operator approvals for the confined native child.
- web33/33 passed9.75s. Actual Ollama fake-HTTP telemetry, Gate/tool/session journals, untrusted output and
  usage are preserved using an authorized supervisor task/test runner. Added actual worker pending request
  case proving zero HTTP and zero web charges despite supervisor policy.
- queued Lab authority9/9 passed7.05s under the shared predicate.
- client-supervision source cases5 passed; two child-MCP cases used stale dist and emitted the superseded
  exclusive-name schema error. Root must rebuild before rerunning; these are not current source failures.

Source/tests frozen. No broad validation, commits, real providers or user configuration operations performed.
