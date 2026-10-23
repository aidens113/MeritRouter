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
