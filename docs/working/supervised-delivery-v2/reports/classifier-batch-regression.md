# Classifier batching fixture regression

Status: Implemented; selected scoring file passes6/6. No production source changes.

## Diagnosis

Root's loaded full61d572c run observed two classifier requests where the fixture expected one. Test helper window is50ms. `routing/router.ts:151` independently awaits health refresh, source loading and feature measurement before invoking `Classifier.classify`. Simultaneous task submission therefore does not guarantee classification queue admission within50ms; real repository/preflight work under full-suite load can separate those arrivals. `scoring/classifier.ts` correctly starts its window when a prepared item enters the queue, not when tasks were submitted. Its flush selects same-project queue members up to max_batch. No demonstrated production queue bug justifies delaying production requests or enlarging the configured window.

This diagnosis follows the reported loaded failure and inspected control flow; I did not reproduce the exact historical interarrival timestamps in isolation.

## Change and validation

Only `tests/scoring.test.ts` changed. The end-to-end batching fixture now installs a first-two-arrivals barrier immediately before calling the original `Classifier.classify`; both fully prepared tasks enter the real classifier together. The spy delegates unchanged arguments and does not replace queueing, Gate requests, lease/project validation, accounting, response parsing or cache. The third submission bypasses the one-time barrier and exercises the actual persisted verdict cache. Spies restore after service cleanup.

Strengthened assertions check exactly one real classifier request containing two items, both tasks completed and classified, and the repeated task completed with rules+classifier classification without an additional request. The50ms production/test-helper setting remains unchanged; no sleeps or arbitrary larger batching windows added.

Observed `pnpm exec vitest run tests/scoring.test.ts`: **6/6 passed**, batching/cache case4086ms, file4725ms. No broad tests or builds run, no runtime data changed, no shared-document edits, commits or pushes.
