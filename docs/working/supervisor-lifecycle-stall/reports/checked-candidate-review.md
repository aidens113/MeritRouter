# Checked candidate safety review

Status: Source review complete; implementer tests and parent verification pending
Reviewer: checked_candidate_review
Scope: Read-only review of normal candidate sealing and retained checked-task recovery.

## Findings

- Resolved: initial sealing helper used live-index `git commit`. Final helper creates an immutable `commit-tree` for the captured tree and publishes it with expected-old-HEAD `update-ref` CAS. Source checks and read-only test inspection cover index mutation during sealing and concurrent HEAD preservation.
- Initial retained-task helper requires completed/met coding child ownership, no Lab evidence, matching original worker session/workspace/head/base, unanimous successful declared check revisions/digests, scoped check artifacts tied to final worker action execution IDs, exact current action-source proof, no pending/running actions, and the exact staged patch digest. These are appropriate conservative prerequisites. Final helper retains those checks and delegates exact-tree publication to the immutable sealing helper.
- The session event index's model-response `name` is the runtime endpoint ID, so original worker attribution can be reconstructed from that trusted row rather than model output.

- Resolved: general action listing is capped at 500 rows. Separate pending/running/uncertain-status queries prevent a hidden old active request from passing the no-unsettled-work prerequisite; uncertain work without a quiescence receipt refuses recovery.
- Resolved: action proof explicitly binds JSON action task/project and nested lease task/project in addition to SQL-scoped lookup, original command, source, cwd, job, final invocation and successful completion.
- Integration recalculates target HEAD and commit list after sealing, then retains the exact verified-tree guard. No Lab candidate is rewritten by legacy recovery. A crash after sealing can retry from the now exact checked HEAD without replaying unchecked changes.

## Validation

No reviewer tests run: implementation was changing. Read the new normal native fake-provider regression, immutable-tree/index/HEAD race cases, and retained proof/attribution negative-control tests. Their execution results belong to the implementer/parent, not this report. No live state, application, shared-document, configuration, or approval changes by this reviewer.

## Remaining verification

No remaining source-review blocker identified in the reviewed diff. Parent must independently validate frozen source and actual retained-task integration. Direct helper tests do not alone establish the complete integration tool/runtime path. In-flight Git calls retain existing process behavior with authority checks around each await; reviewer did not perform cancellation timing experiments.
