# Local supervisor baseline measurement

Outcome: Done

## Scope and changes

Worker implementation of Brief `local_supervisor_baseline`, standard worker,
gpt-6.1-sol, medium; existing main checkout. Owned source and new test only;
no shared documents, existing tests, commits or pushes changed.

- Added `packages/router/evals/offload/lib/local-baseline.mjs` with the fixed
  `runDirectLocal` and `reviewLocalOffload` interfaces.
- Both use one native `/api/chat` POST for valid invocations, an explicit
  HTTP `127.0.0.1:<port>` origin, `redirect: error`, a 240-second abort signal,
  non-streaming structured JSON schema, deterministic sampling and an 8,192-token
  generation bound. There are no retries, tool calls or commercial clients.
- Ollama `prompt_eval_count` and `eval_count` supply input/output token usage.
  Missing or invalid counters produce null usage. Malformed or invalid model
  content retains valid measured counters.
- Direct prompts read only explicitly requested fixture sources. Canonical
  relative paths, symlink/junction refusal, real-path containment, regular-file
  checks, per-file and combined 128 KiB source bounds protect those reads.
- Read-only kinds return an answer; coding kinds return only allowed complete
  file changes. Unknown fields, duplicate paths and combined content above
  128 KiB are refused. Neither source function writes files or executes code.
- Review receives supplied report/check strings only and returns a validated
  `accept` or `reject` recommendation. The lead retains grading and acceptance.
- Responses are read through a bounded reader (1 MiB), canceled after reading,
  and validated with zod; incomplete Ollama envelopes are rejected.

## Validation evidence

Command (from `D:/MeritRouter/packages/router`):

```text
npx vitest run --no-file-parallelism tests/offload-local-baseline.test.ts
```

Observed: exit 0, 1 test file passed, 23 tests passed, 117 ms test time.
All transports were synthetic global fetch stubs. No model, Ollama service,
paid endpoint, credentials or network listener was invoked.

Tests cover native request shape, scoped source disclosure, no source writes,
out-of-scope/duplicate/extra file output refusal, usage retention on malformed
JSON, review decisions, local origin restriction, traversal rejection,
input/output bounds, linked source refusal (Windows junction exercised), HTTP
and timeout failures without retries, incomplete responses and missing usage.

## Not verified

- Live local model quality, timing and paired measurement remain the lead's work.
- Recursive typecheck/build and aggregate checks remain the lead's serialized
  validation slot. No aggregate commands or dist builds ran in this worker.
- The caller must supply a disposable synthetic fixture root, apply returned
  files with its own scope enforcement, and independently grade model output.
  Source reads assume no concurrent hostile replacement of fixture paths.
