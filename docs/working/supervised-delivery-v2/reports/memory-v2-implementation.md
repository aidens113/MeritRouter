# Role-scoped memory and trusted preferences (P4)

Status: In progress — core/runtime tests passed; completion/batch validation pending
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Implemented typed scoped memory/preferences, automatic role-budgeted retrieval and manifests,
resume refresh and native/read-only/supervisor injection seams. Parent wired config, supervisor
injection and MCP service adapters; harness owner wired native. Completion/batch injection
has also landed under an expanded brief; validation and integrated typecheck are underway.
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

Project preferences live under `projects/<p>/memory/preferences/<id>.md`; global preferences
under `global/preferences/<id>.md`. Other typed project memory uses `memory/<id>.md`.
Memory is data; it does not grant tool, spend, execution or final-acceptance authority.

## Validation observed

Combined P0/P2/P4 focused run: **60/60 passed**, comprising 25 delivery-contract tests,
22 quality/budget tests and 13 memory tests. Memory coverage includes a real read-only
provider request receiving automatic context with persisted manifest, cross-project global
preferences, rejected invented/changed/expired authority, scoped supervisor writes, actual
CAS races, revocation/resume, grant-before-read privacy, role/headroom caps, preference
priority ahead of long Current State, raw agent bypass denial and task-relevant retrieval.
Completion/batch changes landed after that run and need their own actual-request tests.

## Boundaries and follow-up

Classifier calls classify technical task metadata; injecting product memory is intentionally
not forced through an alternate Brain principal. Role caps are configured, but classifier
omission/relevance decisions need explicit session-manifest treatment in its adapter.
This unit does not install a cross-process memory cache or automatically infer/promote
global lessons. Supersession references retain provenance; contradictory records remain
data to surface rather than silently overwrite. Parent owns public docs, authenticated
MCP/panel wiring and stable integrated validation after all source edits stop.
