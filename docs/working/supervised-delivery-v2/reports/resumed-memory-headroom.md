# Resumed memory headroom and install preference bindings

Status: Implemented; focused validation complete (see results below).
Owner: delivery-contracts implementation worker
Date: 2026-10-23

## Current State

Read-only, native coding and supervisor runners now pass actual available tools including
their terminal definition, actual generation output allocation and a non-output margin to
both fresh memory injection and resume refresh. Output is reserved once. The supervisor's
startup charter is assembled before memory headroom is measured. Resume keeps its transcript
and offered tools, replaces only automatic memory blocks, and rechecks live records/ACLs.

The executor also preserves its trusted install Brain before project overlays. Canonical
global/preferences reads use that binding for automatic context and explicit brain_read,
brain_list and brain_search prefixes, with the current project role principal. Ordinary
project records and global lessons retain their existing project Brain semantics. No write
or model-controlled filesystem capability was added.

## Findings

The prior second-project preference test used a shared Brain root. Projects bound to a
different root could not retrieve install preferences because every context read used the
project Brain. Authored projects.<slug>.brain.path is currently rejected by configuration;
the regression therefore installs a trusted runtime ProjectContext override before creating
that project's Brain, then exercises actual routed worker requests against distinct roots.

## Validation

- Headroom plus memory-v2/runtime tests: 18/18 passed before the install-binding extension.
- New distinct-root actual-request regression passed: injection; explicit read/list/search;
  no copied preference in project root; private install-project record absent; subsequent
  request excludes revoked preference.
- Router typecheck passed with both changes.
- Session/native/supervisor regression selection: 25 passed, 1 failed. The first legacy
  supervisor fixture reached supervisor_completed but returned acceptance unmet rather than
  met at tests/supervisor.test.ts:59. Root assigned that diagnostic to the harness worker;
  no acceptance guard or fixture was weakened in this work unit.
- Final combined focused run: 4 files, 19/19 tests passed (40.81 seconds):
  global-preferences-roots, resumed-memory-headroom, memory-v2, memory-v2-runtime.
- git diff --check passed (only existing line-ending conversion warnings).

## Limits

No live-provider calls, full repository validation or panel session was run by this worker.
Historical assistant/tool quotations are not retroactively erased by memory revocation.
Unprefixed project searches remain scoped to the project Brain; install preference search
requires the explicit global/preferences prefix.
