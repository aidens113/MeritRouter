# Git process containment worker report
Status: Implemented; pending supervisor acceptance

## Changes
- Added workspaces/git-process-policy.ts prepareGitProcess(cwd,args,identityEnv?) returning hardened args/env for async git and synchronous metadata callers.
- Shared async git wrapper now applies policy for every invocation. Built-in internal command allowlist prevents shell aliases. Caller config overrides limited to user identity and disabling commit signing; environment overrides limited to author/committer identity/date.
- Forced null-device hooksPath, disabled fsmonitor/signing/editors/pagers/automatic maintenance/submodule recursion, denied Git network protocols and lazy fetching. Clears inherited GIT_* config/directory/external-command/trace injection; ignores system/global config. Git for Windows needs NUL rather than Node's device namespace path, verified in tests.
- Config preflight rejects repository includes (which could be worker-writable) and custom clean/smudge/process filters, merge drivers, trailer commands/cmd, diff commands/textconv and alternateRefsCommand. Failure is explicit before normal Git operation. No conversion silently skipped. Diff/show/log/blame force no-ext-diff and no-textconv.
- Security worker notified to consume helper for task-lab raw sync Git. Supervisor notified of operations/brain-backup.ts remaining raw sync Git outside this brief ownership.

## Verification
- New git-process-containment.test.ts:16 passed on Git2.55.0.windows.3 / Node22.11.0.
- Malicious pre/post commit and checkout hooks, fsmonitor, signing program never touched outside sentinel; ordinary stage, commit with Agent trailer, blame and worktree creation succeeded.
- Each filter/merge/trailer/textconv/alternateRefsCommand fixture failed closed with outside sentinel absent.
- External diff disabled, inherited config/directory/external-diff injection sanitized; alias/config/env override rejection tested.
- Existing attribution.test.ts:3 passed. Repository preparation regressions:13 passed (16 existing tests combined).

## Follow-up: Git working-tree authority
- Before non-diagnostic Git operations, safe rev-parse --show-toplevel must canonicalize to authorized cwd. Configured core.worktree/gitdir redirection cannot move content reads, staging or mutation outside that root.
- Preserves init/config/check-ref-format/rev-parse metadata diagnostics and the exact ls-files -z -- . enclosing-repository probe only when no core.worktree override exists. This retains repository preparation's nested-repository detection.
- Two added regressions verify malicious core.worktree outside file unchanged/index unchanged, content reads denied, legitimate managed worktree stage/read accepted and nested diagnostic probes retained.15 Git tests passed. Repository preparation rerun:13 passed;28 tests combined.

## Compatibility and limits
- Repositories requiring executable Git filters (including Git LFS), custom merge or trailer programs fail closed for automatic Git operations. Supervisor/operator must explicitly handle such host behavior through action policy.
- Repository config includes are denied to prevent executable configuration races through worker-writable included files.
- System/global executable and arbitrary user config is ignored. Three trusted non-executable newline defaults are snapshotted safely (details below); runtime commits provide explicit identity. Local identity and attribution retained.
- This protects fixed Git operations from config-triggered program execution; it is not an OS sandbox. Preflight assumes repository administrative config/includes are not concurrently writable by an untrusted worker, as enforced by repository tool boundaries. A hostile concurrent host process can race any host operation.
- No broad validation or commits; source frozen pending supervisor review.
- Primary Git references consulted: https://git-scm.com/docs/git and https://git-scm.com/docs/git-config (environment config injection, lazy fetch, fsmonitor, filters, merge and trailer commands).

## Read-only full-suite diagnosis (source freeze retained)
- verification-review integrate_task final retry failure reproduced in isolated TEMP scratch using built dist, without source/test edits.
- Sequence: raw fixture Git makes conflicting integration commit; protected cherry-pick conflicts normally; protected cherry-pick --abort succeeds; raw git reset --hard base succeeds; protected cherry-pick retry fails with local-changes-would-be-overwritten, despite no deliberate edits.
- Cause: protected environment ignores system/global Git conversion configuration, while raw fixture Git honors it (Windows autocrlf). Raw reset checks out converted CRLF; protected Git interprets it using different conversion semantics and considers it dirty.
- no-ext-diff/no-textconv readers are supported; not the failure source.
- Recommended product fix: retain only metadata-read safe effective newline conversion values core.autocrlf/core.eol/core.safecrlf from the normal system/global/local config stack using sanitized injection-free env; do not restore executable settings. Preserve local overrides. Add deterministic fixture with explicit conversion config so it does not depend on host defaults. Alternate narrow fixture fix alone is local core.autocrlf=false, but leaves mixed-Git product behavior unresolved.

## Acceptance regression correction (source refrozen)
- Implemented trusted newline snapshot in git-process-policy.ts. Only core.autocrlf/core.eol/core.safecrlf are read from default system then global config using metadata-only --get-regexp, --no-includes and environment without inherited GIT_CONFIG_* injection paths. Values normalized/validated against fixed enum/boolean vocabulary; no executable program or include restored. Local repo values take precedence.
- Snapshot is process-lifetime to avoid multiplying Git subprocess overhead on every operation. User changes to system/global newline defaults require service restart; local repo settings remain live.
- Deterministic regression mocks only trusted metadata query results (yes/off boolean aliases), then performs real raw Git CRLF checkout/reset and protected status/cherry-pick. Confirms local autocrlf override still wins.
- Latest focused git-process-containment suite:16 passed.
- Previously failed verification-review integrate_task acceptance-after-integration test:1 passed,16 skipped. No test edits to that suite.
- Public helper contract unchanged; source frozen. No commits.
