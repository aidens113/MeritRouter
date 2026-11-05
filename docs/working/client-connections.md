# External client connections
Status: Complete
Status detail: Default-off client listener and global panel controls passed focused and production browser validation.
Created: 2026-11-04
Last updated: 2026-11-05
Owner: Senior supervisor agent
Scope: Local editor/chat client integration and related live-operation recovery fixes.
Paired document: none
Related: [operations](../operations.md), [setup](../setup.md), [decisions](../decisions.md)

## Current State

The global Connections page provides a persistent enable switch, listener status and copyable
Ollama/Chat Completions setup values. The simplification revision removes direct project
and profile selection, adds editable host/IP and port, and places agent scope in advanced settings.
The listener remains off by default and starts with the panel when saved as enabled. Closing
the panel or disabling Connections drains active client requests.

Direct requests use an explicitly authorized installation execution, independent
of project tasks, while preserving strict project grants for agent execution. Shared
quota/capacity checks passed and are recorded in the follow-up document.
Native chat/generate NDJSON and Chat Completions SSE are buffered until the model
finishes. Model management, embeddings, Responses, unsupported modalities and universal editor support
are not promised. Tools execute in the calling client.

The [connection modes follow-up](connection-modes.md) adds explicit direct/agent/team virtual
model names and scoped asynchronous agent jobs, with token-owned status/cancellation and global
panel mode/repository/budget controls. Direct requests preserve caller history and use normal
key/model fallback; agent jobs use existing workers and retain approvals and verification.

Independent review corrections prevent abandoned client requests from replaying as background
jobs, reject silently dropped tool/format constraints, and isolate synchronous schema validation
from shared compiler state. Uncertain provider accounting is retained during crash recovery.

Related validated fixes classify explicit monthly quota refusals correctly, recover only proven
never-admitted historical slots, allow one proof-gated maintenance startup retry, and optionally
preserve the original deadline for a completed FINAL-rejected repair. None authorizes extra spend.

The final focused checks, recursive builds and production demo/browser checks passed. Current
aggregate regression results are tracked in the connection modes follow-up. External application-specific
compatibility and downstream application acceptance remain separate from this delivered feature.
Operational project history and detailed dispatch evidence remain in the local archive/handoff;
private runtime records are excluded from publication.

## Worker Briefs

- Backend: worker gpt-6.1-sol/max; own connections, config, public exports, queue/lease seams and
  focused tests. Enforce project-scoped Gate, bounded protocols, cancellation and persistent config.
- Panel: worker gpt-6.1-sol/medium; own Connections UI/API, navigation and panel listener lifecycle.
  Verify default-off, saved state, bind errors, restart behavior and responsive layout with fake providers.
- Review: worker gpt-6.1-sol/max; read-only independent boundary and release-diff review.
- Lead: integrate shared service edits, inspect evidence, validate production behavior and isolate
  unrelated legal/instruction changes and private operational records from the release.

## Work Ledger

### 2026-11-05 — Client integration and recovery verification
- Agent: Lead, with connections_backend, connections_panel, connections_review and recovery workers.
- Changed: Connections backend/panel, scoped recovery controls, quota handling and authored documentation.
- Validation: `npx vitest run tests/client-connections.test.ts` -> 26 passed; final compiler guard checks -> 3 passed.
- Validation: `npx vitest run tests/task-leases.test.ts tests/scheduler-async.test.ts tests/project-queue-isolation.test.ts` -> 54 passed.
- Validation: `pnpm --filter meritrouter typecheck`, `pnpm -r typecheck`, `pnpm -r build` -> passed.
- Validation: `node <TEMP>/meritrouter-connections-panel-validation/validate.mjs` -> 13 groups passed, four fake calls, zero browser exceptions; desktop/mobile screenshots inspected.
- Validation: quota tests -> 49 passed; historical recovery tests -> 170 passed; startup retry -> 14 passed; FINAL repair -> 11 passed; portable Lab fixture -> 18 passed. Exact earlier commands remain in local validation records.
- Outcome: Accepted for the scoped feature and fixes; no complete aggregate-regression or downstream acceptance claim.
- Follow-up: Validate individual external clients as needed; retain private operational evidence locally.

### 2026-11-05 — Publication boundary
- Agent: Lead.
- Changed: Compacted this working document; preserved original briefs and operational entries in the local private archive.
- Why: Keep reproducible framework behavior and observed validation separate from user project/runtime data.
- Validation: Reviewed selected source/document hunks and excluded unrelated licensing/instruction changes.
- Outcome: Accepted.
- Follow-up: No private archive or runtime evidence may be staged with the source unit.
