# Supervisor observation priority: negative live finding

Status: investigation complete; no implementation authorized after evidence review.

## Measured live evidence

Read-only source and actual session `s_0mvokqjt8ab8508e616bc` were inspected. The stored log path is relative to the private storage root; direct read used `D:/SwitchYard/.switchyard/sessions/s_0mvokqjt8ab8508e616bc.jsonl`. No write-capable runtime was opened, no provider calls were made, and no live state changed.

The session contained16 await_tasks outcomes. Maximum observed length was11602 characters. The supervisor-tools.ts cap is14000 characters; NONE of these16 outputs contained `[truncated]`. Latest measured outcome was11483 characters.

The latest outcome included18 terminal-task status headers, ending with BOTH current accepted repairs:

- `t_0mvokt9jwdd0100a8bdb4 (api-report-v6): completed, acceptance met, worker_submitted`
- `t_0mvokt9jw19c536bb1c16 (ui-retained-v6): completed, acceptance met, worker_submitted`

The preceding11483/11602-character outcomes also contained the recent UI patch/check evidence at their tails. One10539-character outcome included the current API still-running state after terminal history. Therefore the proposed claim that the current accepted API/UI facts were truncated out is disproved for this actual session. It is not evidence that the model attended to every included fact, but model attention cannot be inferred from transcript ordering alone.

## Source behavior and deferred robustness

Default await_tasks selects s.children values in insertion order. Service awaitResults/collectResults preserves requested task order within completed/pending arrays. The presentation emits operator decisions/actions/budget lines first, then detailed completed results, then pending-task states, and finally applies a global14000-character cap.

This does put old failures before newer terminal results and pending states. With additional or unusually verbose history, a later current fact could be capped; that is a prospective robustness issue, not the measured live cause here. A future scoped change could prioritize current pending/action states and newest terminal results while preserving explicit ID scope, wait semantics and all truthful unmet/evidence statuses. No such change was made in this unit.

## Outcome

Root was notified of the negative finding before any source edits and explicitly directed: do not implement the priority fix now; prioritize the actual operator-decision-feedback defect and app delivery. Companion worker failed_supervisor_recovery was told that this worker's source/tests/docsroles remain untouched and frozen, allowing its own checks to proceed.

Owned report only. No supervisor-tools.ts, tests, docs/roles.md, application, configuration, provider, runtime/store or Git changes. No tests/build were needed for this read-only finding. Existing observation order is deferred; no success or failure of the app is inferred from this report.
