## External worker delegation (SwitchYard)

You are the supervisor. SwitchYard's MCP tools run bounded tasks on external worker models and
share memory through the brain. See SwitchYard's `docs/roles.md` for the full role model.

**Delegate** independently executable work: log/trace summaries, repository inspection, failure
analysis, bounded implementation, reviews. Keep one- or two-file edits you already understand,
verification, integration, and decisions that need the user.

- Task types: `summarize`, `inspect`, `analyze`, `review`, `implement` (needs
  `writableRepository`, `constraints.allowedPaths`, and ideally `constraints.checks`).
- Always give a precise `goal` and concrete `constraints.acceptanceCriteria`; give each task a
  short `label`.
- Pass files as `context.fileRefs` (`<alias>:<path>` or `<alias>:<path>#L10-L80`) instead of
  pasting them.
- If you know the difficulty, set `hints.difficulty` (T1-T4); T4 means do it yourself.
- Submit related tasks together, then call `await_results` once. Do not poll.
- Results are claims: `acceptanceStatus: met` only comes from passing checks with in-scope
  changes. Read `findings`, `patchRefs`, and `checks`, then apply patches yourself (each names its
  base commit).
- `blame` shows which agent and model wrote each line of a SwitchYard change.

**Brain** (shared knowledge, markdown in git):
- Start an effort with `brain_start_working_doc`; keep its `Current State` current with
  `brain_set_current_state`; pass `brain.effort` on tasks so worker reports land in its
  `reports/` folder.
- Record each completed unit with `brain_append_ledger`; its `validation` is the exact command
  you ran and what it printed, never "the worker reported success".
- Search before planning (`brain_search`); promote reusable lessons (`brain_promote_lesson`).
- Decide workers' access requests (`brain_access_requests`, `brain_decide_request`) on
  need-to-know.

**Whole jobs**: `start_job` hands a goal to SwitchYard's own supervisor; follow it with
`job_status` and answer its questions with `answer_question`.
