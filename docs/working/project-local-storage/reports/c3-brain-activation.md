# C3 Brain activation worker report

Supervisor independent final-source acceptance: Brain guards17/17 PASS, including actual
promotion settlement plus alias report71.816s; deletion5/5 also PASS in combined run22/22,
272.96s total. Supervisor reviewed common-owner queue, nested capability and deferred pushes.

Status: production and tests frozen; focused acceptance complete (ordinary Brain10, unique guards17, projects8). Supervisor independent integration verification pending. Owned files: brain/brain.ts; tests/project-metadata-brain.test.ts; tests/brain.test.ts; tests/projects-brain.test.ts; this report. No other source/shared documentation/commits owned.

## Diagnostic evidence

Original exact projects-brain index-links case reproduced its 30s timeout without changing assertions or limits. A temporary method trace showed real initialization, adoption and attributed publications continuing normally, rather than a self-lock. The trace was removed. Exact original case with supervisor-approved CLI `--testTimeout=120000` passed all original assertions in 37.757s (40.70s total). This establishes finite multi-publication overhead exceeding the old fixture budget. Source product deadlines remain unchanged. A full-file diagnostic with CLI120 is running to determine which individual fixture budgets need an explicit allowance; no blanket Vitest config change.

Earlier failed30s roots were retained, not broadly removed; the failed fixture itself attempted cleanup and produced ENOTEMPTY while its timed-out publication continued. The measured120s case drained naturally and cleaned successfully.

## Implementation underway

The supervisor's prewrite guards are retained. Host BrainMutationControl passes opaque repository mutation capability through ensure and deletion/index writes. Common-owner fence acquisition now precedes the legacy Brain serialization lock for existing Git repositories, avoiding lock-order inversion when project deletion already owns sorted common-owner authority. Non-Git repository creation retains legacy initialization serialization, releasing it before common-fence acquisition.

`ensure({mutation})` performs idempotent bootstrap under the original capability rather than awaiting an initializer queued behind that same outer lease. `removeProjectFolder(...,{mutation,deferPush})` forwards the capability through folder removal and root README publication, excludes the removed slug while config still names it, and drops SQL index rows only after both publications have completed. Remote pushes are queued with a mutation scope/deferPush and drained by host `pushPending()` after releasing the outer lease. `regenerateIndex(actor,control)` forwards the same optional control.

Pending and uncertain publication outcomes remain typed failures. No product budget, authority assertion, live provider request, source metadata or alternate checkout was changed/created.

Production source frozen SHA256 brain.ts: `CAA7365DBA06F6A57469BB6F85ABB78D45160A8727DF1D74BA7605360DB287D9`. Source diff whitespace check passed. Git-backed non-committing mounts now derive their actual Git owner before effects; initialization includes any configured project-index mount owner in its common-owner scope. A foreign host capability is checked before creating an absent Brain root.

Test cleanup now tracks complete started Brain calls and waits for them before SQLite close and temp Git-root deletion, including when assertions fail. No EBUSY or ENOTEMPTY is suppressed. Diagnostic trace removed. Final new coverage includes queued bootstrap under an original host capability, configured-slug README exclusion, actual uncertain README publication retaining SQL recovery rows, non-committing Git-backed mount refusal, no directory creation on a foreign capability, and remote pushes only after the outer lease is released.

## Additional measured results and correction

- Previous snapshot ordinary `brain.test.ts`: 10/10 PASS318.003s. Measured >30s cases36.306/41.181/43.651/34.065/44.704/49.790s, initialization serialization29.830s. Supervisor approved explicit120s only for these seven native-publication fixtures; access-only and autoapprove bounds unchanged.
- Projects diagnostic6/8 PASS509.293s. Six original assertions passed (links38.184s, isolation52.861s, no-grant8.484s, rejected-specific67.674s, held-approval65.585s, no-reviewer67.269s). Combined dual-promotion fixture exceeded120s, and automatic Gate settlement remained pending after the original internal60s poll. These are diagnostic failures, not accepted results.
- Approved product optimization: after lifecycle/capability/expected-digest/path checks and outside-edit adoption, compare the actual existing bytes against exactly normalized target bytes. If identical, refresh the guarded SQL index and return the same null-commit outcome without replacing the file or invoking another selected-index transaction. Existing CRLF bytes are never normalized into equality.
- Fresh heavy rerun after optimization: original links PASS30.012s; combined dual-promotion/provenance/rejection fixture PASS96.693s. Its finite measured flow now fits approved explicit120s fixture budget. Gate automatic-settlement case still failed independently of Git publication latency.
- Fresh final guards62530:15/16 PASS; sole failed CRLF fixture incorrectly assumed selected publication preserved its initial working-tree CRLF. Reworked the fixture to explicitly non-committing Brain, requiring actual existing CRLF then actual LF effect. Final selected CRLF/falsy/no-op-positive run10403:6/6 PASS20.72s (10 unrelated selected skips), no source change required for that fixture correction.
- Earlier runs97159/53003 started before source edits completed and later loaded expanded test files against cached old Brain modules; their expected failures on newly added owner/falsy guards are not final-source acceptance.
- Final ordinary Brain10 plus unique guards16 run5353 uses exact frozen production source and final fixture budgets, no CLI timeout override. Pending result.

## Automatic settlement investigation (supervisor-owned core)

Isolated Gate fixture45020 confirmed actual reviewer completed in112ms, one correct independent beta-family Gate request, pass verdict on all rubric criteria. Task `t_0mvpr9uzq48ba848e3db3` purpose promotion_review/project alpha completed1793049326782 after starting1793049326670; run_count1, captured incarnation f5d1b9ff7bc0c769eed787458b69fddc. Promotion stayed pending_review for60s with no active Git/Brain locks. This is not resolved by increasing fixture deadlines. Supervisor owns core/service.ts/executor.ts investigation; this worker does not edit core. Isolated31871 instruments settled events and automatic settle invocation to locate the missing boundary, without changing deadlines or assertions. Temporary diagnostic output will be removed before final acceptance.

Final production Brain source SHA256: `62BA680B27C6233E55D0855039EECCAC9D3B1FA1E127BF348C72DDEF008F1D33` (supersedes earlier frozen snapshot hash). No production edits pending.

## Located settlement failure and final source correction

Actual31871 instrumentation disproved missing event/admission: settled event emitted, automatic settle entered, then threw `RepositoryMutationError.lock_busy` from Brain.writeFile/common acquire. The service swallowed that transient failure and left the promotion pending. No provider or polling deadline change was needed.

Supervisor-approved Brain fix queues ordinary effects by shared canonical physical Git common owner BEFORE acquiring mutation authority. Multi-owner effects occupy each affected queue key with the same Promise; no lease is held while queued. Host-supplied mutation scopes bypass ordinary queues and revalidate the original capability, avoiding an outer-capability inversion. Legacy Brain file locks remain inside common-owner authority. This queue is fairness/serialization only; filesystem mutation fences still enforce ownership/publication/command admission, including across processes. Supervisor separately added bounded lock_busy-only settlement retries in core (d208119); this worker did not edit core.

Targeted fresh queue/Gate regression76983:2/2 PASS90.04s total. Actual two-Brain directory-alias promotion settlement and worker-report flow held the first admitted write >10s, then both persisted successfully86.933s. Real automatic independent Gate review passed77.611s with original explicit90s and internal60s poll and one Gate request. Final stronger alias fixture also checks that no ordinary absolute-Git-dir admission attempt begins while the first write is held, proving queue-before-acquire instead of a timing-only success.

All temporary event/record/settlement diagnostic output and private events access was removed. Final production source SHA256 is now `91DC326A5C02520B0DC8D68A4DB9D3F4369F6C877FEDBFCA647325E40E4D58D2` (supersedes prior hashes). Supervisor recursive snapshot reported no production Brain errors; this worker ran no broad build/typecheck.

Final exact-source/test acceptance30040: all three owned test files,35 cases, maxWorkers3, no CLI timeout override. In progress, no failures so far. Prior26/26 acceptance5353 used the previous source snapshot without the later queue fairness change; it is compatibility evidence, not this final result.

## Final acceptance progress

Exact final-source three-file30040 completed34/35 PASS492.67s. Ordinary Brain10/10 and unique guards17/17 passed, including the stronger no-admission-while-queued alias assertion. Projects7/8 passed, including actual automatic Gate settlement61.809s with original90s/internal60s bounds. Only the combined dual-promotion fixture exceeded its old120s budget under three independent native-Git workers (125.027s including drained cleanup); no cascading cleanup failure occurred. Supervisor approved ONLY that case180s based on measured125.027s plus earlier96.693s all-assertions pass. Product deadlines, poll bounds and every provenance/rejection assertion are unchanged.

Final projects8 serial run32680 now uses final test budgets and exact frozen production source, no CLI timeout override. No repeat of the already-passing ordinary10/guards17 is needed unless another source change occurs.

## Completed focused acceptance

Final projects8 serial run32680:8/8 PASS431.93s total, final production source and final explicit fixture budgets, no CLI timeout override. Combined dual-promotion provenance/rejection case92.958s; real independent Gate review56.927s with its original90s/internal60s bounds. No diagnostic instrumentation remains, no assertions were removed, no cleanup error was suppressed.

Final acceptance evidence is ordinary Brain10/10 + unique guards17/17 from exact-source30040, and projects8/8 from final serial32680. The earlier full35 run retained its honest34/35 outcome because of the old generic fixture120s budget; do not label that earlier run wholly green. All35 distinct final cases now have observed passing results against the same frozen production source.

Owned files remain exactly brain/brain.ts, tests/brain.test.ts, tests/projects-brain.test.ts, tests/project-metadata-brain.test.ts, this report. No source checkout/metadata directory, provider call, broad build/typecheck, core source edit, commit or push was performed by this worker. Core settlement retry is supervisor-owned d208119. Production SHA256 remains91DC326A5C02520B0DC8D68A4DB9D3F4369F6C877FEDBFCA647325E40E4D58D2. All own test processes have completed.
