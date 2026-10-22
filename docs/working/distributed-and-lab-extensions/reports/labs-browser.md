# Report: labs-browser

## Outcome

Complete for the approved bounded static-render unit; source frozen for supervisor review. This is not completion of L5 browser support. JavaScript/hydrated-application checks remain required follow-on work with an actual OS network containment prerequisite, as explicitly agreed with the supervisor.

## Design and integration contract

Human recipe entries accept `kind: browser`, mandatory `mode: static`, absolute browser executable, declared HTTP service/path, bounded viewport/time/resource/screenshot limits and native DOM assertions (exists, text_contains, title_contains). Models select only an already-declared check name through existing lab_check. Existing string/command checks retain their behavior.

The renderer executes no application scripts. Native DOM protocol operations inspect assertions; there is no evaluate/script-action input. Screenshots are PNGs with validated size/hash references. Optional LabCheckResult.browser evidence includes static mode, script-disabled marker, assertion results, bounded console/page errors/violations, blocked target/connection counts, resource counts/bytes, exact repository heads and screenshot metadata. Raw pixels, executable arguments and profile paths are absent from status/tool metadata.

`LabManager.browserArtifact(project,name,checkId,artifactId)` validates project/lab/stored-check ownership, metadata, fixed read bounds and SHA-256 before returning `{metadata,bytes}` to trusted callers. Pixels stay outside public status/logs. Artifacts survive browser/profile cleanup for the retained lab; explicit lab destruction removes their lab-owned bytes. No new panel/API retrieval route is included in this unit.

Browser profiles and Windows AppData directories are private per check. An owned wrapper token and OS process/listener proof protect the debugging connection and cleanup. Existing birth/command-based individual termination/proof logic is reused. Timeout/cancel/failure closes the CDP client and guard and terminates the owned browser tree before profile deletion; ambiguous cleanup retains ownership evidence and fails the check.

The page is offline before content navigation. A controlled negative navigation probe must fail with ERR_INTERNET_DISCONNECTED without reaching its listening endpoint. Every application HTTP resource is intercepted; Chrome never receives continueRequest. The broker alone fetches GET/HEAD from the currently running, positively owned lab service origin, checks ownership before/after, enforces aggregate/per-response/count limits and refuses redirects/cross-origin requests. Injected CSP sandbox denies scripts/connect/frames/workers/forms; resolver-deny, disabled QUIC and dead-end proxy are additional guards. Unexpected application targets are paused/closed. Chrome-internal UI/component targets are closed and counted; proxy connections are refused and counted rather than forwarded.

## Findings recorded during implementation

- Initial actual Chrome startup failed its non-default profile guard. Chromium could not resolve its default AppData path in the minimal environment. Creating private AppData/Local and AppData/Roaming directories under the private profile fixed this without using the user's profile or disabling the guard.
- Installed Chrome creates browser_ui/component extension targets even with disable-extensions. Those are refused before execution and counted. Treating successful guard refusals as an escaped connection incorrectly failed otherwise valid checks; application-origin escapes still fail.
- Actual static DOM/screenshot case passed in 17.42s, including exact heads, PNG retrieval/integrity, scoped lookup refusal, closed browser PID and removed profile.

## Validation

Package typecheck passed. The stable-tree combined run passed 26/26 tests (8 real Chrome/schema browser cases plus 18 existing Labs lifecycle/integration cases), 221.51s. Browser cases covered static DOM/exact-head PNG retrieval, script-dependent assertion failure, cross-origin resource/redirect refusal with zero foreign TCP/HTTP contacts, bounded responses/screenshots/tampered artifacts, foreign-port rebound while the recorded wrapper remained running, cancellation cleanup, and one-second timeout cleanup. After the final serialized/capped Fetch queue changes, the affected real-Chrome static, cross-origin, byte/count/screenshot and artifact-integrity cases passed 3/3 in 78.90s. After formatting the new source/tests, the same affected cases passed again 3/3 in 79.93s on final frozen source. Package typecheck and git diff --check passed after formatting. Five unrelated browser cases were deliberately filtered from these narrow reruns; they passed in the preceding 26/26 combined run. No full suite/build was run in this worker unit; supervisor owns integration acceptance. All fixture managers and browsers were closed by the completed test cleanup; no worker-started panel or provider calls.

## Limits and required follow-on

This is a static-render check, not hydrated app verification. Application script exceptions, client-side state transitions and hydration/integration failures are not exercised. Script-dependent assertions must fail rather than being reported verified.

CDP offline/interception/flags and the trusted local broker are not an OS network sandbox. Tests can establish ordinary navigation/resource refusal and owned cleanup; they cannot establish absence of every browser-process DNS/UDP/implementation side channel or defend a compromised browser executable/OS. A JavaScript-enabled mode needs a real process/container/network policy that limits the entire browser tree to the broker, including DNS/UDP/WebRTC/WebTransport and subprocesses; it must be independently tested before being exposed. No such mode or unsupported containment guarantee is delivered here.

Screenshots are private rendered content and may contain sensitive application data; they are not automatically supplied to models. Textual metadata and console output redact configured environment values and ownership nonces. Pixel-level secret redaction/OCR is not claimed.

Root owns final supervisor reuse semantics: every saved browser.heads entry must equal the current corresponding lab head, rather than checking only one repository/revision. That cross-boundary runner predicate and later native/external routing integration are supervisor work.

Requested branch-collision follow-up was inspected without changes: current lab.ts creates switchyard/lab-<projectPart>-<name>-<lab-id-suffix>, so the suggested plain same-name cross-project collision was not confirmed in this snapshot.

No ephemeral task Labs, Compose, package manifests, shared docs, public exports, core service/executor or panel changes. No commits/push, user install or live provider requests.

## Owned file inventory

- New labs browser-schema.ts, browser-protocol.ts, browser-process.ts, browser-network.ts, browser-check.ts, browser-artifacts.ts.
- Existing labs recipe.ts, checks.ts, lab.ts integrate declared checks, stored evidence and scoped artifact retrieval.
- New tests/labs-browser.test.ts and tests/fixtures/lab-browser-server.cjs.
- This report only; shared distributed-and-lab-extensions.md brief changes were pre-existing supervisor edits.

Fetch broker work is serialized and accepted paused requests are capped by max_resources (maximum 100). The first policy refusal aborts the check; incoming CDP messages are ignored after failure/abort. Per-resource and total byte limits apply while streaming. This bounds concurrency and queued ownership probes rather than spawning an ownership inspection for every simultaneous subresource.

Implementation references checked: [CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/), [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [script execution disable](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setScriptExecutionDisabled), [Chrome remote-debugging profile guard](https://developer.chrome.com/blog/remote-debugging-port). These protocol mechanisms are not an OS sandbox.
