# Plan report: bounded normalized model-request capture

## Status and scope
Report-only investigation of frozen source418b106. No source/shared-doc edits, builds, tests, services, providers or user data operations. This is a proposed future implementation, not verified capture behavior. Existing historical payloads cannot be invented. Panel's current bounded journal replay remains a separate unit and must label its provenance.

Recommendation: capture a bounded explicit normalized Gate projection keyed by each admitted requestId in private SQLite storage. Do not retain raw HTTP bodies, serialize ProviderRequest wholesale, or reuse generic ArtifactStore for private payload delivery. Keep accounting authoritative and capture observational: a capture fault cannot change provider retries, paid spend, fallback, cancellation or outcome classification.

## Observed source contract

- gateway/direct.ts:137 normalizes req.chat per selected endpoint, deleting unsupported response_format. The for(;;) key loop starts145, ledger.reserve is188, provider call construction is231-243. Capture this explicit normalized input after admission and before final post-await authority validation. A mere Gate.request input snapshot misses endpoint transformations.
- sqlite-request-ledger.ts:120 allocates newId('r') for each reservation. direct.ts:255-262 settles a key error then continues its key loop, which reserves again. Thus the inspected implementation gives each admitted credential retry its own request row/id; it does not reuse one immutable row for all keys at the endpoint. Endpoint fallback also reserves another id. Prove this with tests when implementing; do not rely on executionId as payload identity. Keys rejected before reservation produce no model_requests row and must not invent one.
- providers/client.ts:ProviderRequest includes credentials, entire resolved provider, signal/cacheKey; never capture that object. Its documented complete contract makes one HTTP attempt per call. Provider-side internal server tool/search behavior may still be opaque.
- providers/openai-compatible.ts:buildOpenAiBody transforms role/messages, temperature, tools/tool choice, token parameter names, response format, cache key, provider bodyExtras/search fields. providers/anthropic.ts converts messages/system/tools/cache breakpoints. A normalized Gate projection is not the exact serialized wire body, provider-injected defaults or raw response. Label this distinction in both API and UI.
- runners/types.ts:106-133 ask syncs transcript and logs modelRequest/modelResponse. scoring/classifier.ts:129-158 also creates per-member classifier sessions and logs both. runners/batch.ts records per-member requests/responses around shared ask. Do not claim classifier generally has no journal. These journals can reconstruct specific successful calls when an exact requestId response association exists; failed endpoint/key attempts and direct Gate callers may lack that association. Tool schemas/endpoint-normalized request details are not fully retained by model_request events (tools are names, responseFormat only type).
- scoring/classifier.ts Pending fields and shared flush do not establish project partitioning: its chat joins pending task descriptions. Capture cannot assume all classifier participants share a project just because model_requests.project_id stores the first participant's project. Completion Scheduler batches are explicitly project-scoped. Treat mixed-project capture as private/unavailable in a project view, unless classifier isolation is separately fixed and verified.
- runners/coding/policy-gateway.ts:135 uses ask, so external coding's model gateway participates in normal Gate capture. Native/read-only/completion/supervisor/reviewer/classifier/batch Gate requests reach the same direct path. No extra runner capture hooks are needed; they would duplicate content and still miss direct calls/fallback.
- direct.ts:after response records policy violations and may discard a provider response after settlement. Capture must retain bounded normalized output as an observed response with policy_violation=true, not mislabel it an accepted task answer.
- direct.ts:probeClient is uncharged discovery/tool-probe traffic without task/requestId admission. First implementation explicitly excludes it and other scanner HTTP, key checks and arbitrary bypass ProviderClient calls. Do not create bogus budgeted request rows for probes.
- gateway/gate.ts:request tracks in-flight promises; close drains them. This is the required lifetime for awaited capture work. RequestLedger outcomes intentionally exclude model messages; preserve that accounting boundary.
- storage/artifacts.ts writes whole content to task/shared directories and its read trusts indexed rel_path with an unbounded readFileSync. It does not supply the required private scoped bounded payload API. Avoid generic artifact references that model-facing tools can fetch as a side effect of this feature.
- projects/deletion.ts:160 clears model_requests.project_id while retaining accounting rows. A capture table must delete private payloads before that anonymization, not leave them visible as unscoped historical data.

## Normalized capture and attribution

Allocate no capture identity before a successful ledger reservation. One private record per model_requests.id, never per executionId, session id, endpoint, timestamp proximity or prompt digest. Input has the exact **bounded normalized selected-endpoint** model/messages/options at that boundary. Output is the bounded ProviderResponse message/tool calls before runner parsing or policy discard. Captured input for an aborted reservation is planned input with not_dispatched state, not proof of HTTP.

Resolve requestId/executionId/endpoint/model/purpose/tier/project and participant task IDs from the reservation/authoritative rows, not a model payload. Persist a private participant-project set at capture creation before task deletion; compare current request scope at read too. All participants must belong to one authorized project for that project to receive payload. Mixed-project classifier/shared prompts return unavailable/mixed_project_payload without revealing foreign project/task identities. Zero-participant Gate calls have only the request's existing explicit scope; unscoped rows require operator/unscoped access, never adoption into whichever panel project is selected. Unknown/dangling attribution fails closed for payload access.

Capture an optional correlation group for the logical Gate invocation (new opaque gateCallId, not authority) and safe attempt ordinal to help link fallback rows. This is separate from requestId. No credential label/ref/account id or secret-bearing URL belongs in the public capture. Existing request metadata can continue displaying its own approved attribution; capture must not broaden its scope.

## Projection DTO for panel/backend coordination

Proposed exported readonly, zod-validated API projection (names are not existing exports):

```ts
type CaptureAvailability = 'complete' | 'partial' | 'unavailable';
interface RequestCaptureView {
  schemaVersion: 1;
  requestId: string;
  provenance: 'normalized_gate_v1';
  availability: CaptureAvailability;
  unavailableReason: null | 'not_captured' | 'disabled' | 'expired' |
    'evicted' | 'capture_failed' | 'corrupt' | 'mixed_project_payload' |
    'scope_unavailable';
  dispatch: 'reserved' | 'dispatch_intent' | 'not_dispatched' | 'outcome_unknown';
  input: CapturedInput | null;
  output: CapturedOutput | null;
  outcome: null | { kind: 'succeeded'|'failed'|'uncertain';
    httpStatus: number|null; errorKind: string|null;
    possiblyConsumed: boolean|null; policyViolation: boolean };
  omissions: CaptureOmission[];
  originalBytes: number|null;
  storedBytes: number;
  capturedAt: number|null;
  expiresAt: number|null;
}
interface CapturedInput {
  model: string;
  messages: CapturedMessage[]; // explicit role/content/tool-call shapes
  maxTokens: number;
  temperature?: number;
  tools?: CapturedTool[]; // name/description/bounded JSON parameters
  toolChoice?: 'auto'|'none'|'required';
  responseFormat?: {type:'json_object'} | {type:'json_schema';schema:CapturedJson};
  webSearch?: {via:string;alwaysOn:boolean;maxUses:number;maxResults:number};
}
interface CapturedOutput {
  content: string|null;
  toolCalls: Array<{id:string;name:string;arguments:string}>;
  finishReason: string|null;
}
interface CaptureOmission {
  path: string; // bounded structural path, not filesystem path
  reason: 'byte_limit'|'count_limit'|'depth_limit'|'image_locator'|
    'unsupported_value'|'scan_limit';
  originalBytes: number|null;
  storedBytes: number;
  omittedCount?: number;
  sha256?: string; // only when computed over the full original field
}
```

CapturedMessage retains system/user/assistant/tool roles, null assistant content, tool_call_id and bounded tool call ids/names/raw argument strings (not reparsed/repaired arguments). Content arrays retain bounded text parts. Image URLs/data URIs are omitted and replaced by safe image-locator omission metadata, optionally full-field hash/size; never persist image bytes or fetch locators. This deliberately yields partial capture for multimodal messages. Ordinary links inside text remain literal text, never autoload. No markdown HTML execution, images/iframes/previews or automatic outbound fetches.

CapturedJson is JSON-only, finite, with count/depth/byte bounds. Tool parameters and response schemas are preserved structurally only within those bounds; do not retain invalid half-JSON as a valid schema. If a whole subtree is omitted, represent an explicit omission marker alongside it and mark partial. Whole response tool arguments can remain truncated opaque strings with omission metadata; never claim executable/replayable validity.

`requestCapture(sy, requestId, {project}): RequestCaptureView|null` is the proposed insights wrapper. Null means unknown/inaccessible request, with the same externally indistinguishable behavior for wrong project. A visible request with no payload returns a view with unavailable reason, not 404 for the request page. Returned projection contains no storage path, private participant project set, foreign task ids or raw auth/provider objects. Supervisor owns public index/insights exports; panel consumes this DTO only. It may coexist with journal replay as another explicitly named provenance; never replace exact missing data by nearest execution/session or by the task goal.

## Whole-record resource bounds

Recommended reviewed first defaults (implementation proposal, not model/provider facts): maximum encoded record1MiB, of which input512KiB, output256KiB and metadata/omissions within remaining envelope; at most256 messages,64 tool definitions,64 tool calls,16 levels and10,000 JSON nodes; individual text fields at most64KiB. Omission entries max128 with aggregate dropped-count summary. All numbers are UTF-8 bytes, not UTF-16 characters. Validate final JSON byte length again before persistence and on read. Never JSON.stringify the whole ProviderRequest/body first and only then truncate.

Walk only the explicit safe projection with bounded traversal; use deterministic per-field byte budgets and preserve original ordering. Do not split UTF-8 sequences. Prioritize role/correlation structure and recent message content within the input envelope, recording which earlier fields were shortened/omitted. A shortened prompt is partial, never complete. Output limits are independent so a large prompt cannot consume the response budget. Hashing/scanning also has a fixed work cap (e.g.8MiB scanned content); unknown original byte length/hash remains null/absent rather than pretending a truncated digest is the original.

Explicitly excluded: HTTP headers (including telemetry headers), Authorization, provider credential/key/account config, vault refs, environment, resolved provider URLs/bodyExtras, cacheKey, AbortSignal, raw Request/Response, internal filesystem paths and stack traces. The projector is an allowlist; never serialize and remove known keys afterward. Apply existing known-secret masking to any selected diagnostic field as defense in depth, but do not persist raw provider error bodies/messages in this first capture. ErrorKind/status/possiblyConsumed suffice; request page already has separate bounded approved error metadata.

Model content itself can contain arbitrary user secrets, repository text, private URLs or paths. No regex can reliably discover them while preserving exact content. Private project authorization/retention, explicit capture policy and truthful sensitivity disclosure are required. Do not describe full prompts as sanitized or guarantee absence of secrets embedded in user/model text. This feature never feeds captured prompt data back into models automatically.

## Private storage and lifecycle

Use a new append-only migration after task-Lab worker releases migrations.ts. Suggested table request_captures: request_id primary key references model_requests(id) on delete cascade; schema_version; private project_scope_json; input_json/output_json/outcome_json; input/output stored byte lengths; omissions_json; phase; unavailable_reason; captured_at/updated_at/expires_at. Strict CHECK bounds and schema validators; index expires_at and scoped retention selector. Input is immutable once inserted. Output/outcome are write-once idempotent per requestId; repeated identical write is no-op, conflicting bytes mark capture corrupt/refuse overwrite. State progression only reserved -> dispatch_intent -> terminal/not_dispatched. Accounting state remains solely in model_requests/paid_spend.

Why SQLite JSON instead of artifact files: single bounded durable write/read, scoped authorization, transactional retention/deletion, no arbitrary file refs/paths, no blob orphan recovery or artifact-tool exposure. This does not migrate storage backends. A future external object adapter needs its own ownership/atomicity design.

Human config proposal under storage.request_capture: enabled default true for this requested future feature; max_record_bytes/max_project_bytes/max_total_bytes/retention_days bounded by hard upper caps. Suggested default retention7days, per-project128MiB, global512MiB, maximum10,000 retained captures. Validate policy with zod; models cannot change it. Snapshot policy for each admitted request so reload cannot mutate its in-flight semantics; disabled policy creates only safe unavailable metadata when feasible. If config scope is deferred, supervisor must explicitly approve fixed internal defaults and document them rather than silently retaining forever.

Prune expired payloads and oldest payloads under project/global budgets in small bounded transactions without changing request/charge/paid history. Keep a tiny bounded tombstone or explicit unavailable reason until normal accounting history retention; cap tombstones too. Never delete reserved paid requests or accounting records to free capture capacity. Capture-size metrics count actual stored bytes. Storage refusal yields unavailable without changing provider behavior. Do not run unbounded full-store cleanup on each Gate call.

Project purge must remove capture payloads using persisted scope before model_requests.project_id is cleared, including mixed-project records containing that project's content (deleting whole mixed payload is safer than redacting joined text). Project archive retains capture only under existing scoped archive policy and TTL. Ordinary public request reads must not auto-adopt cleared project ids. Add captures to footprint/preview accounting where appropriate, but do not count them as paid/model requests or alter budgets.

## Write ordering and failure semantics

1. Successfully reserve the physical request with existing RequestLedger; only then construct bounded capture input. No row for denied admission or a skipped key/endpoint. A reservation aborted before HTTP may have a planned input record and not_dispatched state.
2. Await best-effort input write through a private RequestCaptureStore. After that await, repeat AbortSignal plus persisted task lease/cancel/deadline checks immediately before provider invocation. Never put awaited capture after the existing final assertion without another assertion. If capture fails, record capture_failed metadata when possible and continue the original provider policy; do not treat it as a provider failure.
3. Record dispatch_intent before calling ProviderClient; it means invocation intent, not proof bytes reached a provider. A crash after this marker and before response is outcome_unknown until authoritative model_request recovery explains more; never label it definitely sent/not sent. If cancellation prevents invocation, settle definitely-unsent as today and best-effort mark not_dispatched.
4. On provider success/error, prepare bounded output/safe outcome independently. Preserve authoritative quota/health/ledger settlement ordering before returning or trying fallback. Await capture terminal write in an isolated guarded path/finally even when settlement throws, retaining useful response evidence; rethrow original persistence/provider error unchanged. Capture cannot suppress a ledger uncertainty error or make a possibly consumed request not_billed.
5. Never place capture writes inside the provider try/catch such that a capture exception enters asProviderError, key rotation, endpoint fallback or paid retry. All capture failures are swallowed/classified as capture telemetry failures at their own boundary. No automatic retry of HTTP for missing/corrupt capture. Retry only an idempotent capture write against the same requestId, bounded and tracked.
6. Default local SQLite writes are bounded, synchronous within their transaction behind an awaitable API. Do not Promise.race an uncancellable background DB write and then close its DB. Gate's existing in-flight request set includes input/terminal capture work; close drains it before DB close. Retention has its own tracked bounded lifetime if asynchronous. Avoid opening new timers/services.

Storage can fail so no design honestly guarantees every payload exists. A capture outage must yield an explicit unavailable representation or unknown no-record reason if even metadata cannot be written; historical absence and total write failure cannot always be distinguished. No crash-atomic claim across HTTP and SQLite is possible. A captured normalized response does not prove task acceptance and may coexist with accounting uncertainty.

## Proposed private API and file partition

```ts
interface RequestCaptureStore {
  begin(input: BeginCaptureDTO): Promise<void>; // reserved request only, safe normalized input
  dispatched(input:{requestId:string}): Promise<void>; // intent marker
  complete(input: CompleteCaptureDTO): Promise<void>; // success/failure/uncertain/no-dispatch
  read(input:{requestId:string;project:string|null}): RequestCaptureView|null;
  prune(input:{limit:number}): Promise<CapturePruneResult>;
}
```

All DTOs strict zod/JSON-only and private attribution derived from DB; no callback/Db crosses the interface. Keep safe projection/bounds in new gateway/request-capture.ts, persistence/retention in new storage/request-captures.ts (or separate sqlite-request-captures.ts if a real port is introduced), admin projection in new admin/request-capture.ts. Do not put prompts in admission RequestOutcomeDTO, paid math or generic artifact tools.

Executable first implementation brief (after migrations/overlapping ownership freeze):
- Own new gateway/request-capture.ts, storage/request-captures.ts, admin/request-capture.ts; gateway/direct.ts and gate.ts; minimal core/service.ts wiring; config/schema.ts request-capture policy; projects/deletion.ts exact payload purge/footprint; append-only migration allocated by supervisor. Ask before other schema files or existing admin/entities.ts changes.
- Supervisor retains insights/index public exports and authored docs; new DTO is the panel boundary. Panel worker owns request page/rendering separately against frozen DTO.
- No provider transport/body serializers, runners, classifier, admission math, session journal or artifact-store changes needed for normal Gate capture. Existing per-project classifier ambiguity is handled by payload refusal; a separate classifier-isolation fix may be desirable and must be explicitly scoped.
- Tests: new tests/request-capture.test.ts, gate-request-capture.test.ts, admin-request-capture.test.ts; modify existing project-deletion tests only for this new storage dependency; proportional existing ledger/paid/provider/caching/close checks. No providers, real stores, user4477 or live quota. Build/typecheck/router focused tests then freeze; supervisor independently validates panel/full suite/package as appropriate.

## Required fake-provider acceptance

- Free and fake paid responses, direct Gate without journal, classifier with journals, native/external ask, shared completion batch: one capture per admitted physical request and correct participant attribution; no duplicated records per session/member.
- Force two same-endpoint keys: first invalid/rate-limited key then success; assert distinct requestIds and safe different capture states under same executionId. Endpoint fallback with response_format unsupported/supported demonstrates different normalized payloads; repeated rounds with identical executionId demonstrate no overwrite/nearest-prompt guess.
- Failed/uncertain/possibly-consumed/no-choice responses, policy mismatch/disabled-cache-write response discarded, abort before and after reserve and during delayed input write, lease/deadline loss without AbortSignal. No HTTP after cancellation recheck. Failed metadata capture never changes number/order of HTTP calls, spend, quarantine or fallback behavior.
- Inject begin/dispatched/complete failures and ledger settlement failures independently for paid success/error: original exception classification and conservative cost retained; no capture-induced HTTP retry. Actual close waits pending capture and never closes DB first. Kill fixture around reserved/intent/response/capture barriers for honest unknown/partial states if crash recovery is claimed.
- Oversized prompt/tool schemas/arguments/output, Unicode/multibyte, huge counts/depth, invalid JSON-only values, unknown fields, data URI and credential-bearing image location. Assert whole-record and projection byte caps, bounded omissions/work, exact/partial labels and no automatic link/image loading.
- Synthetic credential sentinel only in ProviderRequest credential/provider URL/headers/vault/cacheKey must be absent from saved capture and admin view; user content containing an arbitrary secret-like string remains literal private content unless policy disables capture, demonstrating the documented limit rather than claiming magic redaction.
- Two projects, classifier shared cross-project payload, zero-participant unscoped call, deleted/archive/expired/evicted/corrupt data. Wrong project gets no payload/foreign metadata; project deletion removes mixed payload before anonymizing requests. Historical no-capture request remains usable with explicit unavailable, never invented prompt.
- Retention limits preserve request/charge/paid rows and byte accounting; repeated idempotent capture writes do not duplicate, conflict cannot replace earlier input/output. Page renders text/tool calls safely, no executable HTML or autoload, and never calls full capture raw wire body.

## Open decisions

Supervisor approval is needed for configured retention/default-on capture and migration/file ownership after active Lab work; no source implementation was started. Projection shape above is ready for backend/panel coordination. A future raw provider-wire body capture would be a separate reviewed feature with materially different credential/bodyExtras/provider transformation risks and is deliberately outside this proposal.


### Classifier follow-up handoff (read-only)
Parent will brief classifier isolation separately after the running full suite; no source was changed here. Classifier already owns Db, so classify enqueue can resolve authoritative tasks.project_id by taskId without alias inference or widening router.prepare. Missing/empty project must fail closed or use a private per-task batch key; cfg.brain.project is not evidence that an existing unscoped row belongs to the selected project. Lookup/validation must precede any project-specific cache return. Current cached(specHash) and INSERT OR REPLACE classifications use only spec hash/rulebook, so batch partition alone leaves cross-project cached rationale reuse. Namespace cache keys by authoritative project plus specHash (deterministic encoded/hash key can avoid a migration), ignore legacy unscoped cache hits in project mode and test repeated identical specs across projects. These are source-derived follow-up requirements, not a reproduced privacy incident. Capture's independent participant-project-set read guard remains necessary even after batching isolation.
