# Retained recipe quiescence reconciliation

Status: Implemented and frozen; awaiting combined validation/independent review
Worker: repair_context_handoff
Worktree: D:/SwitchYardRouter-repair-quiescent

## Read-only live evidence

Production SQLite opened with better-sqlite3 readonly:true,fileMustExist:true. Source UI task t_0mvof2ck584c7903ff4b2 is completed, run_count1, incarnation02e51460f899ebf02e33c0b11eb4f73e. Author s_0mvof2yp16ecca8ab6022 is completed, recorded workspace base3b5b6fa5fc5ccd978ac753d9a58a6752f2f16a88/headc7896f0e1703db4151d8713b1a72101987475fd1.

Journal sequence:
- seq300: actual outer run_checks intent call_8qihlavf, ids[check:1,check:2],stop_on_failure:false.
- seq301: host operation started; operationId=s_0mvof2yp16ecca8ab6022:call_8qihlavf.
- seq302: child run_recipe command intent; callId=s_0mvof2yp16ecca8ab6022:call_8qihlavf:recipe:0, args{id:check:1}. Its child journal outcome is missing.
- seq303: durable host outer operation settled unknown_effect, diagnostic worker action wait cancelled or original lease lost.
- seq304: actual outer run_checks tool_outcome exists, unknown_effect. Outer is settled; nested journaled recipe threw before writing its own outcome.
- seq317: author ended completed/worker_submitted.

Exact broker action wa_0mvof7is3de7bc88131ab: uncertain, invocationId equals child callId, npm install,timeout30000, correct source task/project/parent job/worktree/run/incarnation; executionStartedAt1792968631460, executionTimeoutMs28870,quiescedAt1792968660758. Output exitnull(timeout). Current retained workerSourceIdentity exactly7024c7e202587d0c6fc49f9e1cda6f86497783f3b0e81836a2826caf3fe79b5d, matching this action AND later completed final install action. No data/log/config mutation by this investigation.

## Proposed bounded correction

Reconcile only source eligibility, never claim command success or append fake journal outcomes. A focused harness proof helper may recognize the missing nested declared recipe outcome only if exact parent run_checks intent/started/settled/outeroutcome and unique exact child invocation broker action prove terminal quiescence on the same source. Bind source task/project/author session/child callID/recipe index+declared command/worktree/current sourcehash/run/incarnation. Require source task+author completed initially; require actual execution start and host quiescence for completed/uncertain action. Pending/running/missing/ambiguous/foreign/mismatched/corrupt evidence refuses.

Native hydration still verifies clean immutable source, scoped commits, authority and exact final candidate; source stays unmet and repair checks must run anew. Original journal remains unchanged. Do not derive authority from diagnostic prose, elapsed time, task terminal alone, unrelated quiesced action or generic unknown_effect.

Root approved NEW harness/repair-operation-quiescence.ts, owned workspaces/repair-hydration.ts and focused new tests/repair-quiescent-operations.test.ts. Implementation delivered in assigned isolated tree only.


## Delivered proof and limits

- Helper only recognizes completed source task + completed author and ONE unresolved nested run_recipe command. Existing normal ownership/author/clean-head/active-action/merge/scope/attribution fences remain mandatory.
- Exact child callID derives sessionID + actual outer callID + recipe ordinal. Declared check index/command and optional timeout must match parent run_checks args and original source task checks.
- Require exactly one parent intent, host operation started receipt, settled unknown_effect receipt, complete untruncated outer tool_outcome and completed author ending in proper sequence. Canonical outer result must equal durable settled result; workspace alias/worktree mode/revision must match. Missing, duplicate, foreign or malformed proof refuses.
- Read broker row directly without mutating reconciliation. Require exactly one row for source task+child invocation; SQL row ID/project/task match JSON; actual action request_key must equal original action identity hash excluding reason. Command/cwd/invocation/task/project/parent/run/incarnation/sourcehash all match. Reject operation actions, pending/running/unknown statuses, missing execution or quiescence, invalid timeout/timing, or mismatched source.
- Only completed/uncertain executed actions with authoritative executionStartedAt/executionTimeoutMs/quiescedAt are recognized initially. Quiescence must occur after actual execution and before host settled/author ending. This never interprets unknown_effect as command success.
- Helper does not write any journal/action/task record or authorize replay/resume. Source stays unmet and full repair checks remain required. Multiple unresolved effects still refuse; direct run_recipe, arbitrary commands/edits and unsupported statuses are not reconciled generically.
- Source eligibility refusal now identifies original source taskID and pending tool/callIDs, without command arguments or environment data, so a supervisor can continue independent API work when UI source proof is blocked.

## Observed validation

- pnpm install --offline --frozen-lockfile -> exit0,219cached packages,0downloads; pre-dist executable-bin advisory warnings only.
- pnpm exec vitest run tests/repair-quiescent-operations.test.ts -> **22/22PASS**,1file,9.27s;5.64s tests.
- Real executable regression creates attributed12-file UI source and real session/worktree, invokes actual journaled executeOperation(run_checks), approves exact mediated fixture command, waits real timeout/process-tree quiescence, observes uncertain action + settled unknown_effect + missing child outcome. No fake positive journal/action receipt. Native source resolver succeeds, source acceptance remains unmet, and original session event array is unchanged.
- Negatives cover pending/running, absent quiescence, foreign project, wrong incarnation/run/cwd/call/command/source/timeout, impossible timing, operation-action mismatch, missing/ambiguous broker rows, missing start/settled/outer outcome, corrupt output, foreign/duplicate note, changed actual sourcehash and noncompleted source.

Source/tests frozen. Patchartifact-reference peer current_memory_priority owns only repair-reference.ts + supervisor-lifecycle.test.ts in SAME isolated tree, also frozen with46/46narrow tests. Neither worker started combined typecheck/build while peer edited. Root owns combined checks, independent review and live activation. No provider calls, app edits, live state mutations or commits. Production investigation used readonly SQLite/log reads and safe source hashing only.
