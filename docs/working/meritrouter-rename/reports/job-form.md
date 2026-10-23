# Jobs creation section placement
Status: Implemented and frozen in isolated child worktree

## Isolation / inventory
- Worktree: D:/SwitchYardRouter/.claude/worktrees/meritrouter-job-form
- Branch: feat/meritrouter-job-form (base9fa547a).
- Changed apps/panel/app/p/[slug]/jobs/page.tsx.
- Added apps/panel/components/client/job-create-section.tsx.
- This report only. No primary-tree edits, commits, backend changes or dependency install.

## Behavior
- Existing jobs/list empty state now appear before creation. New job is the bottom section.
- New section is native details/summary, collapsed by default, keyboard-operable, with visible focus and an open/closed chevron. Summary describes creation; supervisor help remains inside.
- Form is always rendered as children, including while closed. Collapse does not unmount/reset React form state or draft.
- Existing setup warnings, NewJobForm props, lab list, repositories, budgets/security and submission behavior unchanged.
- Empty-state copy directs users to open New job below.
- Existing /jobs#new links open and scroll on initial hydration, route change, hash change, history navigation and same-page anchor clicks (including repeated same-hash click). Modified/new-tab/download clicks are ignored by the local listener. Event listeners/animation frame cleaned up on route change/unmount.
- Live refresh does not rerun opening/scroll effect for unchanged pathname, preserving manual collapse and draft.

## Verification
- TypeScript transpile syntax passed both changed/new source files using primary dependency read-only as supervisor permitted, with all commands executing in child worktree.
- Reviewed form remains unconditional, setup warning contents/form props unchanged, accessible native summary and clean lifecycle handling.
- No builds, full tests, demo seed, browser launch, provider requests or user process operations.
- Root owns integrated typecheck/build and desktop/mobile/keyboard/deep-link/draft browser acceptance after primary full suite completes.

## Extended project UI steering
Status: Implemented; source frozen for supervisor integration.

Additional inventory:
- apps/panel/app/p/[slug]/page.tsx
- apps/panel/app/p/[slug]/agents/page.tsx
- apps/panel/components/requests-view.tsx

Behavior:
- Overview retains its existing content and now includes the existing requests/tier usage graphs inline. Only Overview and Activity tabs remain; pickTab resolves legacy ?tab=usage to Overview.
- Added reported/input/output token totals for 24 hours and an hourly stacked input/output token chart from the existing project-scoped timeseries query. Input explicitly includes cached input. No extra data queries.
- Agents retains one project-scoped agentsView query, adds a URL role filter, four summaries clearly scoped to listed agents, role/activity badges, task/session counts, first/last activity with relative and absolute times, labeled project-scoped agent links, and useful filtered/unfiltered empty actions.
- Requests summary uses Reported tokens with an approximate input-plus-output total when cache usage is unknown. The short explanation explicitly includes cached input. Fully missing input/output usage remains Unknown; known-cache New tokens and cost/DTO semantics remain unchanged.

Validation:
- TypeScript transpile syntax passed all five touched/new source files using the supervisor-authorized primary compiler dependency read-only.
- git diff --check passed (only existing Windows line-ending normalization notices).
- Reviewed existing component signatures, AgentRow fields, single scoped agents query, and legacy tab fallback directly.
- No primary-tree source edits, builds, dependency installation, full tests, demo/provider/user process actions or commits.
- Supervisor still owns integrated typecheck/build and browser checks: overview/legacy usage URL/token chart, role filter/detail navigation/mobile agent table, reported/known/missing token examples, and the jobs keyboard/deep-link/draft cases above.

## Usage-first ordering refinement
- Moved the existing Labs and running/queued jobs plus repositories JSX intact into Activity, ahead of its Worker and Recent agents cards. All existing links/actions retained.
- Overview now starts directly after tabs with the reported/input/output token totals, then token chart and request/tier charts. Shared header, notices, attention, headline stats and budget approvals remain unchanged.
- Re-ran project-page TypeScript syntax check and git diff --check: passed. Source frozen again for supervisor build/browser acceptance.
