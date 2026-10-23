# Demo security fixture worker report
Status: Source frozen; awaiting fresh router build for seed execution

## Changes
- apps/panel/scripts/seed-demo.mjs now verifies its exact canonical panel/.demo path before recursive cleanup. Existing .demo redirection through junction/symlink fails before deletion.
- Demo generation explicitly selects security.outside_repository=supervisor for scripted integration checks. This is fixture-only; generated config returns to production human_only after all seed services stop.
- Added explicit trusted in-process demo operator using public validated insights.listWorkerActions/decideWorkerAction. It approves only task-declared exact fixture commands for the persisted request project and canonical cwd within verified .demo. Generic operations, undeclared/outside actions and more than256 approvals are denied. No provider/engine operation granted.
- Poller is serial, stops on decision failure, and stops/drains before wrapped sy.close. Failures propagate after service close rather than silently approving or hanging.

## Verification
- node --check apps/panel/scripts/seed-demo.mjs passed.
- Resolved panel root D:/SwitchYardRouter/apps/panel; existing D:/SwitchYardRouter/apps/panel/.demo is a normal directory without LinkType/Target redirection.
- Actual seed not run yet: supervisor requested fresh router build first because dist is stale while Labs migration integration completes.

## Remaining
- Run seed after supervisor confirms current router dist, inspect all fixture assertions/no warnings, final human_only config and stopped fixture service processes. Report exact outcome.
- No other source edited for this brief; no commits.
