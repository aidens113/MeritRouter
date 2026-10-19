# SwitchYard Router

Policy-enforcing router that lets a Claude Code supervisor delegate bounded tasks to approved,
free external models through a FreeLLMAPI gateway. Standalone project.

## Layout

- `packages/router` (`switchyard-router`): library, CLI (`switchyard`), and MCP server.
- `apps/panel`: Next.js web panel (models, pools, requests, provider keys, tasks).
- `docs/`: decisions, setup, recovery. `plan.md`-era decisions live in `docs/decisions.md`.

## Commands

- `pnpm install` at the repo root.
- `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.
- Node >= 22.11 (22.12+ recommended). better-sqlite3 is pinned to 12.x: 13.x crashes on Node 22.11/Windows.

## Branch and push policy (managed automatically by the agent)

- `main`: released, known-good state. `dev`: integration branch. Feature work happens on `dev`
  (or short-lived `feat/*` branches merged into `dev`).
- **Push `dev`** after each significant, self-contained change once `pnpm -r typecheck` and
  `pnpm -r test` pass: a completed subsystem, a phase checklist item, a bug fix with a test.
  Do not push half-finished work that breaks typecheck or tests.
- **Fast-forward `main` to `dev`** when a phase (or a coherent group of features) is complete,
  its acceptance checks pass, docs are updated, and the build succeeds. Never force-push either
  branch; never rewrite published history.
- Commits: one logical change each, imperative subject, body explaining why. Never commit
  secrets, `.switchyard/`, databases, worktrees, or `.env` files.

## Conventions

- TypeScript strict, ESM, zod for every runtime boundary.
- Every model request goes through `Gate` (admission + verification). Nothing calls the
  gateway directly.
- Hard limits must be enforced in code; anything only estimated is labelled as such.
