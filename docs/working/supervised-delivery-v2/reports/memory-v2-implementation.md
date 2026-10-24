# Role-scoped memory and trusted preferences (P4)

Status: Complete — focused core and runtime validation passed; pending FINAL combined checks
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Implemented typed scoped memory/preferences, automatic role-budgeted retrieval and manifests,
resume refresh and native/read-only/supervisor injection seams. Parent wired config, supervisor
injection and MCP service adapters; harness owner wired native. Completion/batch injection
has also landed under an expanded brief and actual-provider-fake validation passed.
No live calls, user configuration edits, commits or app changes.

## Public contract and behavior

- `brain/memory-record.ts`: strict version1 memory schemas, rendering/parsing, scoped paths.
  Kinds cover user preferences, project facts, decisions and empirical lessons, with author,
  source, original instruction, status, revision, expiry and supersession reference.
- `brain/preferences.ts`: `MemoryPreferences` receives a trusted authorization resolver.
  Project memory requires supervisor/human role plus scoped write grants. Workers propose
  through reports. All writes require explicit expected digest (null means create-only).
  Preferences require an operation/record/project/scope/expiry-bound resolver capability;
  write body must match the literal initiating instruction. A model saying "user said" or
  reusing a legitimate instruction for different content/ID fails. Global inferred lessons
  still use the existing independent promotion service. Revocation preserves the Git history.
- `harness/memory-tools.ts` exposes `projectMemoryTool()` to dispatched supervisors as
  `write_project_memory`. Runtime principal/actor/scope come from the authenticated session,
  never arguments. Strict inputs permit facts, decisions and empirical lessons only, require
  source/CAS digest and cannot select another project, global knowledge or user preferences.
- Raw agent writes to project typed-memory paths are reserved/denied; only the scoped
  service can produce validated writes. Existing legacy project-fact ACLs remain unchanged.
  Human panel writes use the separately owned typed adapter rather than raw editor PUT.
- `context/memory-manifest.ts`: role caps default supervisor12k/reviewer6k/worker4k/
  summarizer-classifier2k, enabled by default and explicitly configurable.
- `context/memory.ts`: authenticated grants precede reads/rendering. Active global and
  project preferences precede Current State/contracts. Facts, decisions and approved lessons
  use task/criterion-relevant scoped FTS, with bounded discovery and omission/read-more
  metadata. Revision digests are recorded. Whole records are omitted rather than silently
  truncated. Actual prompt/tool/output allocation clamps headroom; callers without assembled
  prompts conservatively reserve half the context plus serialized task overhead.
- Resume removes old automatic memory blocks and builds a live authorized snapshot, so
  revoked/expired entries disappear from that injected context. Explicit historical tool
  outputs or assistant quotations are not retroactively rewritten.
- `harness/worker.ts` brainContext is now async; read-only/native/supervisor callers await it.
  Completion uses the same scoped memory environment; batch items have separate manifests,
  evidence refs and prompt memory. Packing refuses cross-project batches and shared memory
  any participant lacks permission to read.
- Actual independent `verification/review.ts` sessions construct the reviewer Brain principal,
  inject memory using assembled prompt/tool/terminal/output headroom and persist a reviewer
  manifest. Read-more tools enforce the reviewer's own ACLs, rather than the author's grants.

Project preferences live under `projects/<p>/memory/preferences/<id>.md`; global preferences
under `global/preferences/<id>.md`. Other typed project memory uses `memory/<id>.md`.
Memory is data; it does not grant tool, spend, execution or final-acceptance authority.

## Validation observed

Focused observed passes: **63 tests**, comprising 25 delivery-contract tests,
23 quality/budget tests and 15 memory tests. Memory coverage includes a real read-only
provider request receiving automatic context with persisted manifest, cross-project global
preferences, rejected invented/changed/expired authority, scoped supervisor writes, actual
CAS races, revocation/resume, grant-before-read privacy, role/headroom caps, preference
priority ahead of long Current State, raw agent bypass denial and task-relevant retrieval.
Additional actual fake-provider tests prove one-shot summarizer injection and that two
otherwise-compatible batch items are split into separate physical prompts when only one
may read private memory. The private body appears in exactly one request. No live provider
or production data was used.

## Boundaries and follow-up

Classifier calls classify technical task metadata; injecting product memory is intentionally
not forced through an alternate Brain principal. Every classifier session records an explicit
memory-manifest omission reason identifying technical metadata classification.
This unit does not install a cross-process memory cache or automatically infer/promote
global lessons. Supersession references retain provenance; contradictory records remain
data to surface rather than silently overwrite. Parent owns public docs, authenticated
MCP/panel wiring and stable integrated validation after all source edits stop.

## Independent reviewer adapter follow-up

`tests/reviewer-memory.test.ts` proves an actual native-author/independent-reviewer run injects
the global preference under a 300-token reviewer cap while excluding a private project fact
visible to the author. Its persisted reviewer manifest contains only the authorized preference.
Together with evaluator regressions, **15/15 focused tests passed**. No live calls were used.

## Legacy verdict-cache safety and native maintenance

The legacy ordinary verdict cache does not bind scoped memory digests or reviewer ACL revisions.
`verification/phase.ts` therefore disables reuse and reusable key creation while automatic
memory is enabled. Calibration records remain collected; this is a deliberate safe opt-out,
not a claim that memory-aware cache keys are implemented. Three narrowly cache-specific legacy
fixtures explicitly disable memory so they still test that older feature independently.

Observed `reviewer-memory` plus `verification-calibration`: **11/11 passed**. The regression
seeds an otherwise-eligible legacy cached verdict, enables memory with a new preference and
proves a fresh reviewer receives it, then revokes it and proves a third review no longer sees it.

Observed `native-project-memory`: **3/3 passed**, including a real dispatched supervisor
advertising/calling the typed tool and persisting its authenticated task/role attribution,
CAS create/update conflict handling, worker/borrowed-principal denial, foreign grants denial,
and refusal of raw global/preference arguments. No live calls or commits were made.
