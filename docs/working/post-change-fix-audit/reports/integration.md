# Integration audit

Status: Complete, read-only source/history review; supervisor verification pending.
Baseline: dev 371875a with existing dirty live-run fixes, 2026-10-23.
Scope: Recent committed integration, request recovery/session authority, Labs/Compose and distributed persistence. No product changes, tests, builds, provider calls, live stores or services operated.

## Findings and proposed order

### P1 — Integrated acceptance remains unproven after the fixture repairs

The latest full-suite evidence in `distributed-and-lab-extensions/reports/integration-fixture-cleanup.md` is **1083 pass, 2 fail, 1 skip, 107 files, 756.65s**. The capture fixture and Windows cleanup fixes subsequently passed eight focused tests and serial worker repeats; commits a0df257/67f62e4 contain those repairs. This does not establish that either failure remains, nor establish a passing integrated tree. The newer opt-in supervisor cap commit 9df5efd and current uncommitted changes are later again.

Plan: freeze the intended candidate, run focused changed-subsystem checks first, then recursive typecheck/build and the complete router suite. Re-run demo production panel/API/screenshots for current panel changes. Record the exact candidate and any intentional skip. Repackage/install the final candidate in an isolated prefix against temporary config, checking bundled panel and CLI/MCP startup; historical fresh-install success does not validate the current artifact. This is an acceptance gate, not a newly proven product regression.

### P1 — Strict uncertain request holds can strand capacity with no supported recovery control

Source: `packages/router/src/gateway/capacity.ts:134` counts strict request slots independently of task lifetime; lines 328/335-337 intentionally prevent ordinary release of uncertain slots. `admission/request-receipts.ts:102-105` refuses project purge while unresolved request/transport holds exist. No request-recovery or attempt-registry implementation exists in the current source inventory. The accepted operator-recovery report 182d3cb is a **design**, not an implementation.

Trigger/consequence: client crash or uncertain persistence/settlement leaves a strict hold; task completion/restart cannot prove the original transport stopped. Operators can remain capacity/deletion blocked without a supported inspection/action path. Keeping the hold is correct fail-closed behavior; deleting it or adding a TTL would lose that guarantee.

Plan: implement scoped diagnostics, durable trusted host/process-birth and full invocation/slot-cohort ownership, then receipt-backed human local-hold retirement only with independently established drain/death proof. Keep original dispatch intent and conservative financial uncertainty. Settled-uncertain late usage needs a separate append-only accounting correction protocol; do not change `reconcile` into an override. Integrate unresolved-financial deletion blockers before enabling retirement.

Acceptance: exact killed-client fixture, unknown legacy owner shown ineligible, PID reuse/foreign project/changed cohort refusal, late original settlement, commit-then-ACK-loss replay, duplicate/conflicting operation identities, no provider retry and no financial release from local retirement. Existing detailed report is executable design input; recheck its source assumptions at dispatch.

### P2 — Request admission authority does not complete session/effect journal authority

Source: `sessions/recorder.ts:274-289` allocates sequence from each recorder instance, durably writes the JSONL line and only afterward updates the SQLite index. There is no durable session writer epoch/nonce CAS across recorders. `sessions/recorder.ts:237-239` removes a local tool intent before appending its outcome. Commit 7b6ac61 adds captured request authority before runner journaling; it does not replace these persistence semantics. The merged `session-authority-plan.md` explicitly remains a report-only S1-S4 design.

Trigger/consequence: two recorder instances or stale resumed writers can race canonical event identity; write/index acknowledgement failures can leave journal/index or local intent state inconsistent. This is a real architecture gap for crash recovery and distributed writers, not evidence that ordinary single-writer use currently corrupts data.

Plan: S1 canonical SQLite session event bodies plus operation receipts and generation-bound writer authority, classifier first; S2 awaited runner/review/shutdown migration; S3 service-enforced effect authority and ambiguous-effect reconciliation; S4 bounded artifact port and crash-safe publication. Keep legacy sessions explicitly scoped. Migration ownership must be freshly assigned: source migrations currently end at request admission; Compose31 is reserved in planning but is not implemented.

Acceptance: concurrent writer/expected-sequence races, takeover plus task/session reincarnation, commit-before-ACK replay, expired/cancelled lease across awaits causing zero subsequent effects, canonical scoped reads independent of JSONL projection, exact owned artifact cleanup, producer drain before DB close. Do not claim full remote safety after S1.

### P2 — Labs L5 remains deliberately incomplete; working snapshots overstate active implementation

`labs/compose-client.ts:80` implements validation only; `labs/compose-engine.ts:217-220` explicitly provides no transport, durable creation receipt or mutation permission. Source inventory has recipe/ownership/engine planning files, no Compose journal/coordinator implementation. Thus the roadmap's claim that a journal/coordinator worker is active is stale task status. Existing C1/C2/pure Engine plans are implemented prerequisites and should not be reimplemented.

Plan: assign serial migration ownership, implement journal/coordinator with fake injected Engine first, preserve original immutable create IDs, then checked Unix-socket transport and retained/task integration. Enable runtime only after disposable-engine acceptance for isolated concurrent Labs, ACK loss, restart, unknown create receipt quarantine, exact-ID ownership and complete cleanup. No engine activation is needed for the earlier units.

Hydration's latest measured blocker differs from older snapshots: Node and full Chrome are prepared, and normal sandbox Chrome fails under accepted proc-ro, while a separately authorized proc-rw diagnostic succeeds. `labs/browser-linux-plan.ts:27` remains runtimeEnabled:false; helper `browser-linux-helper.py:241` includes `/proc` in the read-only proof. Do not call this a missing executable or solved sandbox. Next unit is a separately reviewed ordinary-user browser proc profile; actual CDP pipe, bounded resource containment, zero-contact sentinels and durable browser recovery remain later gates. Revalidate retained fixture provenance before use; this audit did not inspect the host fixture.

### P2 — Distributed persistence remains a roadmap feature, not a working multi-host product

The source inventory still contains synchronous SQLite implementations and filesystem session/artifact authority; async lease/request contracts are partial prerequisites. No PostgreSQL backend or general session/tool/Git/secret authority migration was found. Accepted request generation fencing must remain, but does not supply host affinity or global secret/tool authority.

Plan: complete the remaining explicit async subsystem ports, preserve the default SQLite contract, introduce backend selection plus versioned PostgreSQL migrations/contract tests, then host/workspace affinity and authority, scoped artifacts/secrets/session transport. Real two-host acceptance is the final gate. Do not schedule database replacement as an immediate bug fix or put SQLite on network storage.

## Documentation corrections for the supervisor

- Roadmap/distributed Current State still identifies 663626d as current accepted deployment and 1525960 acceptance as actively running. Git is now 371875a; deployment/process identity was not checked here. Separate last verified deployment from latest source/candidate.
- Historical 998-test failures were subsequently repaired; the newer 1083/2/1 run and focused fixture repairs supersede that old failure inventory. Neither constitutes a passing current full suite.
- Operator recovery and async session authority reports are merged **plans**. Compose journal is not in source. Portable Linux tools now exist according to their retained-fixture report; hydration remains blocked by a measured proc-policy incompatibility.
- 371875a is an empty commit (`git show --stat` lists no changed files), despite its Facebook-clone workspace title. It is not evidence that downstream application content was added to this repository.

## Verification and limitations

Inspected recent Git history, named roadmap Current State, latest recovery/session/browser/fixture/Compose reports and supporting source locations. Product source was not changed and no broad or live validation was run. Findings about unsupported APIs are source-inventory conclusions; infrastructure availability and current panel deployment remain unverified. Supervisor must independently confirm release priorities and gates before execution.
