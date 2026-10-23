# Overview graphs and time horizons
Status: Complete (worker scope; root browser acceptance pending)
Owner: overview_horizons worker

## Changed
- Install Dashboard (/all) now defaults to Overview with actual request/token graphs and
  task tier bars. Project Overview uses the same focused UsageOverview component.
- URL range=1h|24h|7d|30d selects one rolling window for requests, tokens, success rate,
  task submissions and every graph. Invalid, repeated and omitted range values parse
  through zod to24h. Range links preserve other query values; section tabs retain range.
- Former tab=usage links resolve Overview. Projects/Activity/Health remain accessible.
  The existing24h/7d per-project usage/spend table, including qualification and
  unattributed rows, remains under Projects. Operational cards stay outside Overview.
- Buckets include the partial first/current buckets; bounded13/25/29/31 columns.
  Empty windows show visible axes and explain selecting a longer range. Tokens carry
  the token unit and reported approximate total; cached input stays included.
- Multi-day axes include dates, with larger spacing for7d date/time labels.
- Fixed ResizeObserver lifecycle: callback refs attach observation to the newly mounted
  graph after Table/Chart switching, including the existing StepChart consumer.

## Validation
- Offline frozen dependency installation passed (219 packages; no downloads).
- Pure helper assertions passed: all valid/invalid/array/missing ranges, partial and exact
  aligned boundaries for all4 horizons, monotonic intervals and bounded counts.
- Isolated pnpm -r build passed; ordered pnpm -r typecheck passed. Logs:
  node_modules/overview-build.log and node_modules/overview-typecheck.log.
- git diff --check passed (CRLF normalization warnings only).

## Not verified
- Worker did not seed or access primary demo, run providers, or manage user processes.
- Root owns actual browser graphs, table/chart switching, resize, screenshots, final
  integrated checks and publication. No commits or pushes by worker.

## Project selector followup
- Supervisor physically reproduced packaged candidate failure after scrolling a table
  header beneath the desktop menu: menu item right edge hit TH Time, so pointer clicks
  did not navigate. Sidebar sticky stacking context at auto/0 trapped descendant z50
  below main-table sticky th z1.
- Added z40 to desktop sidebar stacking context; no portal/focus/outside dismissal changes.
- Runtime refresh now validates ok/project rows with bounded zod schema and preserves the
  last good list on malformed/error responses. Existing archived filtering stays intact.
- Isolated pnpm -r build and ordered pnpm -r typecheck passed; logs:
  node_modules/overview-switcher-build.log and overview-switcher-typecheck.log.
  Supervisor owns physical hit tests, pointer/keyboard/mobile navigation and explicit
  user-authorized live-panel restart.

## Supervisor review and physical acceptance
- Reproduced on a production packaged panel: at x300 inside Storefront menu row,
  elementFromPoint returned TH Time; physical selection stayed on the original page.
- After z40 correction the same point hits the Storefront span and physical selection
  navigates to that project. Desktop/mobile keyboard, Enter/arrows/Escape focus, outside
  dismissal, archived exclusion and malformed refresh preservation pass with 0 exceptions.
- Supervisor aligned slug validation with existing SLUG_RE, removing artificial64-character
  and display-name bounds so legal fallback labels remain accepted. Final parent build pending.
