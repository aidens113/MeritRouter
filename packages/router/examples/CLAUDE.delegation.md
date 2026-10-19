## External worker delegation (SwitchYard)

Use the `switchyard` MCP tools for independently executable work: log/trace summaries,
repository inspection, failure analysis, bounded implementation, and reviews.

- Pick the task type: `summarize` (answer from supplied context), `inspect` (simple read-only
  lookups), `analyze` (cross-file reasoning, repair proposals), `review` (patch or evidence
  review), `implement` (bounded edits; requires `writableRepository`, `constraints.allowedPaths`,
  and ideally `constraints.checks`).
- Always give a precise `goal` and concrete `constraints.acceptanceCriteria`.
- Pass files as `context.fileRefs` (`<alias>:<path>` or `<alias>:<path>#L10-L80`) instead of
  pasting them; workers load them and must cite them as evidence.
- If you already know how hard a task is, set `hints.difficulty` (T1-T4). This skips the
  classifier and saves quota. T4 means "do it yourself".
- Submit related tasks together, then call `await_results` once. Do not poll with repeated
  status calls; continue independent work instead.
- Treat results as evidence, not truth: `acceptanceStatus: met` only comes from passing checks
  with in-scope changes. Read `findings`, `patchRefs`, and `checks` before integrating, and
  apply patches yourself (they include the base commit).
- Keep architecture decisions and final integration here in the supervisor.
