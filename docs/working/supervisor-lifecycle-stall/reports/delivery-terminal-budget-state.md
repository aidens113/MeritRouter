# FINAL descendant terminal-budget classification

Status: Complete (worker result; root independent review/integration remain)
Workspace: D:/SwitchYardRouter-terminal-evidence
Branch: feat/delivery-terminal-budget-state

## Root cause and minimal correction

core/task.ts TERMINAL_STATES already includes completed/failed/cancelled/budget_exhausted, and requestCancel correctly leaves those historical results immutable. ProductDeliveries.finalDecision nevertheless included budget_exhausted in its separate hardcoded active-descendant SQL list. A completed, fully observed current candidate at handoff could never receive a separate FINAL decision after a superseded exhausted attempt.

Only production change: verification/product-delivery.ts imports the established TERMINAL_STATES and binds that set to a parameterized NOT IN descendant activity predicate. Interrupted and every other nonterminal state still block, including queued grandchildren below an exhausted sub-supervisor. Unknown nonterminal states fail closed. All exact candidate/spec, actor, current independently applicable observed evidence, completed job and handoff requirements are unchanged. There is no task/result/charge mutation, refund, historical acceptance change or evidence shortcut.

Other owned files: tests/delivery-terminal-budget-state.test.ts (new), docs/roles.md (terminal activity versus success contract). No other production paths changed.

## Observed validation

- Offline frozen-lockfile install succeeded219packages, zero downloads,2m11s; pre-dist package-bin warnings only; no manifest/lock edits.
- `pnpm --filter meritrouter typecheck` passed.
- `pnpm --filter meritrouter build` passed.
- `cd packages/router; pnpm exec vitest run tests/delivery-terminal-budget-state.test.ts tests/product-delivery.test.ts tests/product-readiness.test.ts --maxWorkers=1`:3files46/46 passed16.14s, including new18/18.
- `git diff --check` passed (CRLF normalization warnings only).

Controlled temporary fixtures have exact real Git candidate head/tree, completed handoff and four current observed receipt kinds (structural, journey, visual, independent_review) with appropriate distinct runtime/reviewer actors. A separate authenticated FINAL acceptance succeeds for exhausted history just as failed/cancelled/completed historical attempts. The historical task remains unmet, with four already-charged fixture requests and all state/results/events/token charges unchanged, even after an attempted public cancel and after FINAL.

Negatives cover missing evidence, all six nonterminal states including interrupted, active grandchild below exhausted supervisor, missing handoff/completed root state, mismatched spec/candidate digests, changed candidate invalidating old evidence, and project isolation. No provider was called. These are service/store unit fixtures, not claims of real app/browser acceptance.

## Boundaries

No app code, live runtime/store/config/provider state, real grades, history, daemon or other frozen test trees were changed. No worker commits/pushes. Source is FROZEN. Root may independently validate/integrate/build and exercise via fresh passive MCP; this external FINAL guard fix needs no daemon restart or interruption of app work. Existing evidence/failure/charge history must stay intact.
