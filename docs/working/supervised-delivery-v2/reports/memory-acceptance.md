# Report: memory-acceptance

## Outcome

Done: planning-only source audit and implementation design. No application/framework source,
configuration, live services, providers, or runtime data changed. The user rejected the prior
product; passing the previously chosen checks does not rebut that rejection or establish usability.

## What changed and why

This report proposes scoped automatic memory and evidence-based integrated delivery. It reuses
existing Brain and Lab facilities, identifies incomplete runtime prerequisites, and separates
empirical lessons from explicitly authorized user preferences.

### Observed implementation

| Area | Existing implementation | Consequence |
| --- | --- | --- |
| Written knowledge | `brain/brain.ts`: Markdown, per-repository write locks, atomic rename, Git attribution/history/blame, mounted docs, FTS5 search, generated project indexes | Keep one knowledge system; extend metadata and retrieval rather than add a second vector-memory store. |
| Scope | `brain/access.ts`: supervisor project writes, workers own-report writes, project/global read grants; global writes blocked even by broad agent grants | Existing boundaries are valuable. Nested supervisors need job ownership in addition to broad project role defaults. |
| Global lessons | `brain/promotion.ts`, `verification/promotion-review.ts`: project-specificity checks, independent review, provenance, pending/rejected/reverted states | Preserve these gates for model-inferred reusable lessons. They are not the correct ceremony for recording an explicit cross-project user preference. |
| Injection | `harness/worker.ts` injects readable Current State; `runners/supervisor.ts` injects Current State and up to five global search snippets | Role-based grants exist, but a role-budgeted deterministic memory manifest and automatic preference/project-fact retrieval do not. |
| Search | `brain/brain.ts` FTS search uses bounded query terms, BM25 and scope/grant filtering | Useful initial retrieval; add typed scope/status/relevance selection and deterministic budgets before introducing semantic retrieval. |
| Task verification | `verification/checks.ts`, `decide.ts`, `contract.ts`, `core/acceptance.ts` distinguish checks, claims, review and acceptance; bind declared commands to revision | Keep these distinctions; add product evidence rather than relabel structural passes as usability. |
| Integrated checks | `labs/checks.ts` binds browser evidence to all repository heads; `labs/promotion.ts` checks branch ownership, target changes and team settlement | Build integrated acceptance on these exact-candidate checks and immutable environment evidence. |
| Browser | `labs/browser-schema.ts` allows only static mode; evidence explicitly says scriptsExecuted:false | Existing browser checks cannot prove hydration, navigation, login, uploads or any interactive journey. |
| Hydrated isolation | `labs/browser-isolation.ts` exposes unavailable capabilities only; requireBrowserIsolation always refuses | This is an implementation prerequisite, not an option that can simply be enabled. |
| Task Labs | Current operations guidance records automatic worker Task Lab execution unavailable pending durable execution proof | Do not bypass authority or silently downgrade to host execution to meet a testing requirement. |

### Proposed memory contract

1. Keep Markdown plus Git as authored memory. Add validated metadata for memory ID, kind
   (`user_preference`, `project_fact`, `decision`, `lesson`), scope, status, author role/task/model,
   source refs, timestamps, revision digest, supersedes/revocation and optional review-after date.
   A preference stores the original user instruction reference and the bounded authorization it
   records; this is not an API key/credential store.
2. Project supervisors may update project facts/decisions and propose reusable lessons. Workers
   may submit memory proposals through their own report, never edit shared truth directly.
   Nested supervisors own their job section/reports and assigned memory records; changing a
   parent's spec/Current State or unrelated project decisions requires the parent authority.
3. Add a distinct `record_user_preference` service/tool path. Explicit user intent such as
   "use four workers for every project" permits the FINAL supervisor to create/update the
   corresponding global preference without pretending an empirical reviewer discovered it.
   Bind authorization to a trusted initiator identity/session, exact scope/key/content digest,
   original instruction evidence and recorded decision. A model-supplied string asserting
   "user authorized" is insufficient. Existing MCP clients cannot prove the content of their
   private conversation independently; the connection must carry explicit trusted preference
   write capability or use a user-visible proposal/decision path. Do not fabricate human actors.
4. Model-inferred global lessons continue through current independent promotion review. No
   automatic global write just because a supervisor thinks a project finding is general.
   Global preference editing and empirical global lesson promotion remain separate operations.
5. Memory never grants execution, paid routing, publishing or external messaging authority.
   Current user instructions/configured security outrank stale memory. Project exceptions may
   narrow a global workflow preference with an explicit explanation and provenance. Revocation
   is recorded and excluded from future injection; history is retained rather than rewritten.
6. Add compare-and-swap writes with expected digest for shared records. Conflicts return current
   revision and structured merge information. Do not let parallel job supervisors overwrite each
   other using last-write-wins. Version injection snapshots so resumed sessions can explain what
   they saw; append relevant updates with version events rather than silently changing history.

### Default automatic memory injection

Proposed configurable starting caps, not measured optima: supervisor 12,000 tokens, implementer/
analyst/inspector 4,000, reviewer 6,000, summarizer/classifier 2,000. These are upper bounds,
not targets. Effective cap is the lower of role cap and safe remaining endpoint context after
system/tools/current task/output reserves; automatic retrieval should never crowd out its task.

Deterministic priority: applicable explicit user preferences; approved spec slice and interface
contracts; job Current State; relevant project decisions/facts/repository notes; relevant global
lessons; compact failure lessons. A small task should receive a small relevant slice. Do not
inject all reports or repeat a whole project plan into every worker. Reviewers receive the
immutable acceptance spec and independently produced evidence; worker narratives stay labeled
as claims, with no instructions to trust their conclusions.

Each initial/resume context records a manifest: role/cap, selected refs with revision/digest,
selected sections, selection reason, token estimate, truncation/omission information and an
available read-more tool. Check grants before ranking and before rendering. Treat learned text
as quoted data, except explicitly typed authorized preferences rendered within their authority.
Never promote arbitrary prose from retrieved memory into system-level instructions. Cache
deterministically by project/role/spec/head/memory revisions to reduce prompt churn.

### Product acceptance contract

The delegated supervisor is responsible for a coherent running product, not a collection of
accepted components. A completed worker task is evidence input, not project completion.

Before implementation, write a versioned spec with: target user/platform, concrete workflows,
visual references/design requirements, data/storage lifecycle, failure/loading/empty states,
security expectations, excluded features, runnable setup and an acceptance matrix. Each
criterion has stable ID, severity, intended observable behavior and required evidence type.
Every claimed primary feature must have at least one real journey; unreachable controls,
placeholders, mocked interactions and unsupported parity claims fail their criteria. Spec
changes require visible versioning/parent approval, not a worker weakening its own tests.

The default delegated delivery loop becomes spec -> architecture/contracts -> worker briefs ->
component checks -> integrated immutable candidate -> running-product review -> repair ->
final-supervisor handoff. Inspection/review can be delegated, but ownership stays with the
delegated supervisor until handoff. It must ask the FINAL supervisor for resources/blocker
resolution instead of declaring an untested app complete. Explicit partial delivery is allowed
only with visible missing criteria and a final-supervisor decision.

Acceptance layers:

- Structural checks: clean setup, typecheck/build and appropriate tests. These establish a
  baseline, not usability. Independent checks verify evaluator/test changes; required
  evaluator-change review cannot remain `not_implemented` for product acceptance.
- Runtime checks: start exact candidate with isolated fake data, prove health/owned services,
  execute actual backend contracts, verify persistence across restart and appropriate error
  handling. User datasets and real credentials remain untouched.
- Interactive journeys: hydrated desktop/mobile browser exercises primary workflows, keyboard
  navigation, forms, upload, feedback states, navigation/history, reload and persistence. Gather
  page errors, console/network failures, screenshots before/after major actions and structured
  assertions. Tests must fail if controls are inert or client scripts never run.
- Product review: a qualified independent reviewer and delegated supervisor inspect rendered
  screenshots/live journey evidence against the spec's layout, legibility, responsiveness,
  usability and completeness. A generic screenshot or model saying "looks good" is not proof.
  Each defect is mapped to a criterion, severity, reproduction and evidence. If the selected
  model cannot inspect images, route an eligible visual reviewer or report review blocked.
- Final handoff: FINAL supervisor gets runnable commands/URL, checked revision/environment,
  coverage matrix, screenshots/journeys, known defects, budgets and a concise readiness verdict;
  it can launch/check/reject. Integration-ready is separate from final delivery accepted.

For a local social app specifically, journeys must demonstrate account creation/login/logout,
feed loaded images, composing/uploading/viewing a post, likes/comments/saves, profiles/follows,
search, DM compose/delivery, notification actions, mobile navigation, refresh and restart. Stories
and reels require explicit functional scope instead of suggesting video parity from photo slides.
The initial specification decides scope; these examples must not become framework domain code.

### Hydrated browser prerequisite and containment

Implement a separately capability-gated hydrated mode. Reuse static mode unchanged. A trusted
native adapter must establish isolated profile/process descendants and network/filesystem scope,
bind the browser to owned Lab service endpoints, deny uncontrolled egress/downloads/host paths,
and durably record ownership and cleanup before a model can request journeys. The current
nominal BrowserIsolationLease is not proof an adapter exists. Linux network namespaces and
Windows AppContainer have different semantics and require platform-specific actual validation.
If a platform cannot establish those properties, capability remains unavailable and delivery
states the missing test. Do not substitute an ordinary host browser and claim containment.

Checks bind all repository heads plus recipe digest, runtime/dependency identity, spec version,
test plan version, data fixture identity and browser capability/generation. Any relevant change
invalidates evidence. Bounded typed browser actions are allowlisted; no arbitrary evaluate/script
or URL escape. Timeouts, cancellation, crash/restart recovery and owned cleanup are mandatory.

### Implementation file map and sequencing

These are proposed files; no extraction into catch-all helpers. Freeze interfaces before parallel
work, and serialize tasks that touch shared config, migration, runner or public export files.

| Phase | Owned files / extension points | Exit gate |
| --- | --- | --- |
| M1 Memory records and authority | new `brain/memory-record.ts`, `brain/preferences.ts`; extend `brain/access.ts`, `brain/brain.ts`, `config/schema.ts`, append `storage/migrations.ts` only if indexed metadata/authorization journal needs schema | Validated scoped CRUD/CAS, truthful authorization, revocation and cross-project denial tests pass. |
| M2 Retrieval and injection | new `context/memory.ts`, `context/memory-manifest.ts`; extend `harness/worker.ts`, `runners/readonly.ts`, `runners/coding/native.ts`, `runners/supervisor.ts`, `sessions/events.ts` | Automatic relevant context/manifest is bounded and reproducible for each role, including resume and small endpoints. |
| A1 Spec and readiness | new `verification/product-spec.ts`, `verification/product-evidence.ts`, `verification/product-readiness.ts`; extend `verification/contract.ts`, `checks.ts`, `decide.ts`, `core/acceptance.ts`, task schemas | A structurally green unusable fixture fails product readiness; component acceptance cannot complete project. |
| A2 Durable runtime prerequisites | extend existing `labs/task-attempt*`, `process-ownership.ts`, `control-authority.ts`, `browser-isolation.ts` in sync with current lifecycle roadmap; new platform adapter files under `labs/` | Actual platform ownership/crash/cancel cleanup acceptance, not serialized available flags. No fake capability. |
| A3 Interactive journeys | new `labs/browser-journey-schema.ts`, `browser-journey.ts`, `browser-journey-evidence.ts`; extend `browser-schema.ts`, `browser-check.ts`, `checks.ts`, `recipe.ts`, `promotion.ts` | Primary journeys run with scripts and isolated data; exact-environment invalidation and no unauthorized host/network actions. |
| A4 Supervisor and client contract | extend `harness/supervisor-tools.ts`, `runners/supervisor.ts`, MCP tools/schemas, CLI/operations and `admin/insights.ts` exports | finish_job cannot claim final readiness with failed/missing required product evidence; explicit final supervisor decision recorded. |
| A5 Panel and docs | Brain UI/API, Labs detail/recipe, task detail/list and Activity components; `docs/roles.md`, `operations.md`, `setup.md`, charters/examples | UI distinguishes execution, integration-ready and final acceptance; shows missing evidence and injected-memory provenance; screenshots and API/page validation. |

Shared surfaces M1/M2/A1/A4 must be assigned serially or carved by exact file after design freeze.
A2 is a true dependency for automatic A3; M1/M2 and A1 can proceed independently. A1 acceptance
must support an honest unavailable/blocker outcome before A3 exists, not claim parity early.
Preserve existing config behavior during migration; new spec-driven defaults apply to new
delivery jobs with clear upgrade guidance and visible opt-in/exception for legacy task-only flows.

### Required meaningful tests and experiment

- Memory: malicious cross-project/global writes denied even via mounts/batch; explicit authorized
  global preference persists and is injected into a second project; model-inferred preference
  without authority denied; inferred lesson still reviewed; supersession/revocation/CAS race;
  project-local exceptions; secret/redaction policy; memory injection cannot change execution
  permissions; provenance survives restart and truthful agent attribution.
- Retrieval: long docs/UTF text under exact cap, deterministic ranking, no unreadable hit leaking
  existence or content, stale/revoked facts excluded, conflicting records explained, no silent
  dropped spec criteria, evidence refs registered and replay/resume manifest consistent.
- Acceptance negative controls: a beautiful static page with inert buttons, broken hydration,
  placeholder rewrites, missing image assets, empty fake success responses, inaccessible mobile
  menu and data lost on restart all fail the relevant product criteria despite green build/unit
  tests. Reducing or deleting acceptance tests cannot turn failure into success.
- Runtime/browser: stale head in another repo, changed recipe/fixture/dependencies, wrong server
  endpoint, out-of-scope navigation, popup/download/worker/network bypass, reused PID/ownership,
  cancellation during setup/action, server/browser crash and failed cleanup all preserve truthful
  evidence and block promotion as appropriate. Real Linux/Windows adapter tests are explicit
  acceptance dependencies; mocks validate contracts only.
- Final-supervisor workflow: delegated supervisor plans/dispatches/integrates/reviews/tests,
  requests additional budget before violating reserves, returns a blocked/partial result on
  missing capability and waits for FINAL acceptance. Claimed-only worker evidence is insufficient.
- End-to-end trial: use a new isolated downstream app/project and frozen user-visible spec with
  visual examples. Record pre-agreed journey/quality criteria, first-use setup, request/tool-error
  counts, repair cycles, request phases, tokens, elapsed time and reviewer defects. Include a
  real user/final-supervisor usability review before calling it a successful delivery. Compare
  against the prior observed baseline descriptively; a different app/model is not a controlled
  proof of efficiency. Set a bounded trial budget at dispatch and request extensions explicitly.

## Commands run and observed results

Read-only `Get-Content`/`rg` inspections of named Brain/context/verification/Labs modules,
`harness/worker.ts`, runner integration, `docs/roles.md`, current operations and focused tests.
Observed static-only browser schema and deliberately unavailable hydrated adapters directly in
source. `rg` attempts against guessed `runners/supervisor-tools.ts`/`src/team` returned missing
paths; actual integration is `harness/supervisor-tools.ts`. No tests, builds or live calls ran:
this report changes documentation only and does not claim implementation validation.

## Not verified

No runtime prototype, measured context-token optimum, hydrated adapter, live browser/provider
acceptance, memory authorization implementation or future efficiency improvement is verified.
Current source checks do not establish why the prior product felt unusable to the user; the
new spec/review must capture those observable defects without inventing their reasons.

## Open questions or contradictions found

The user's cross-project memory request authorizes designing such a feature, not an unrestricted
standing grant to promote every model inference globally. Explicit preference authority must be
represented truthfully at the initiator boundary. Existing broad supervisor project grants also
need narrower job ownership for nested shared-memory edits. Hydrated browser and worker Lab
execution depend on unfinished lifecycle/isolation work already tracked elsewhere; this plan
must integrate those prerequisites rather than build a parallel unsafe path.
