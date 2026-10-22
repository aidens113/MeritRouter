# Worker report: panel-entities-resume

## Current State

Implemented U3's missing entity routes using public insights. Ready for supervisor integration validation; no commits or builds performed.

## Changes and decisions

- Added project agents list with role filtering and agent detail with Tasks, Sessions, Models, Requests, Changes tabs; summary includes requests, spend, lines added/removed and parent jobs/supervisors.
- Added project repository list/detail and commit detail: repository status, attributed commits, branches, trailers linking related entities, file statistics and disclosed diff.
- Added project request detail and global permalink. Global links redirect to the owning project or qualification scope; unassigned probe requests render directly.
- Added qualification request detail via shared `components/request-detail.tsx` (supervisor extended ownership). Request detail shows accounting, provider/routing fields, citations and related entities; citation links allow HTTP(S) only.
- Fixed RelatedPanel so groups longer than six without a destination retain all remaining items in a disclosure.
- Project route entry validates project, and insights queries receive project scope. Request detail explicitly checks its stored project matches the requested scope.
- Shared brain repository commits deliberately remain outside repository routes per supervisor decision: a shared brain commit diff can reveal other projects.

## Validation

- Inspected existing insights signatures, link builders, shared UI and expected information architecture.
- Started `pnpm --filter switchyard-panel typecheck`; stopped with Ctrl+C at supervisor request while workers still edited shared checkout. No diagnostics were emitted before termination. This is not a passing validation result.
- No repository builds, browser screenshots, HTTP checks or live providers run. Supervisor owns integration validation after edits settle.

## Limits

- Agent request/session/commit lists reflect bounded existing insight queries, not an exhaustive historical export.
- Existing shared entity links already provided all needed URL builders; they were reused.
- Browser rendering, wrong-project 404s, request redirects and repository/commit routes still need supervisor verification against demo data.

## Work ledger

- 2026-10-22: Implemented missing routes and RelatedPanel reachability. Outcome: implementation complete, integration validation pending.
