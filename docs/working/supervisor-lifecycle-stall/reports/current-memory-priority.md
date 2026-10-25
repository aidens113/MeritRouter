# Current memory priority under a constrained context cap

Status: implemented, source frozen; focused checks passed.

## Diagnosis

`buildMemoryContext` iterated relevance results in prefix/search insertion order. It rendered each whole record until the token cap, with no distinction between current decisions and older historical facts. The live manifest selected11615/12000tokens and explicitly omitted the newer next-phase decision after including large historical repair patches. This is selection order, not an ACL or spending-authority issue.

## Change

Owned files: `packages/router/src/context/memory.ts` and `packages/router/tests/memory-v2.test.ts`.

The selector now gathers only authorized, readable candidates and validates managed typed records before ranking. Existing authorized preferences remain first, followed by explicit working-document Current State and repository contracts. Relevant managed decisions follow, then facts/lessons; each typed group uses newest `updatedAt` first with path as a deterministic tie-break. Raw legacy documents retain search order after managed typed records. Duplicate search discovery cannot overwrite an explicit repository-contract reason.

The existing relevance query and30-result/page bounds remain. No new irrelevant record is added, no whole record is truncated, and the token cap, omissions, live digest, source-path/scope/status/expiry validation and access-before-body-read checks remain. Memory remains reference data and cannot authorize execution or spending. A decision too large to fit is still explicitly omitted; the fix does not remove bounded retrieval limits.

## Validation

Initial `npx vitest run tests/memory-v2.test.ts` ->15/15 passed in34.28s. Before final freeze, tightened priority to managed typed records only and made the starvation regression explicitly model old-patch-first retrieval. Final command: `npx vitest run tests/memory-v2.test.ts tests/resumed-memory-headroom.test.ts tests/reviewer-memory.test.ts --fileParallelism=false` ->21/21 passed across3files in47.13s (42.92s tests); final memory-v215/15, reviewer-memory3/3, resumed-memory-headroom3/3.

`git diff --check -- packages/router/src/context/memory.ts packages/router/tests/memory-v2.test.ts` -> exit0, only CRLF normalization warnings.

Three new tests cover the actual cap starvation, newest/tied ordering with irrelevant/expired exclusions, and explicit refs/preferences precedence. Existing revoked-preference resume, cross-project/access-before-read and headroom tests remain.

## Boundaries

No application files, live runtime, configuration, shared working documents or commits changed by this worker. Root owns independent review, recursive typecheck/build, broader checks and publication. No live success is claimed.
