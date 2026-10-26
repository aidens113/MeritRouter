# S4a project Gate and routing isolation

Status: Source draft frozen; focused end-to-end slice passes, recursive integration pending.

Gate's existing database remains the private task/admission/capture store. New optional
ProjectGateContext explicitly supplies coordination DB/config, pinned project identity,
shared execution-grant factory and host grant resolver. Separate roles/installations and
provider/spend database bindings are checked before use. Shared health is attached to the
coordination database once and cannot be rebound by legacy project Gate construction.

Endpoint quarantine and qualification reads use coordination storage. Task classification,
sessions and request captures use the supplied project store. TaskRouter/Classifier reject
a mismatched project Gate. At the existing immediate pretransport guard, split ledger's
single-use assertDispatch is consumed; legacy RequestReceipts remain explicit fallback.
No await was added between this guard and provider invocation.

Fake transport slice4/4 PASS: two project stores with identical local task IDs share one
physical quota; each gets its own prompt/output capture and task charges; actual rule
classification writes locally. Third request is denied at shared quota with no provider call.
Global tasks/sessions/model_requests/captures/classifications remain empty. Cross-project
participants, legacy shared-health rebinding and local provider bookkeeping are refused.
Initial fixture errors (top-level repositories mixed with projects, missing local project
registry row) were corrected without weakening assertions or guards.

Latest combined Gate4 + promotion retry3 =7/7 PASS9.64s. S3 capacity final17 independently
passed separately. Recursive typecheck/build/final suites await coherent source snapshot.

This does not activate core service, scheduler, entrypoints or any real provider. Internal
taskless discovery/qualification needs S8 synthetic-store/grant authority; no empty-lease
exception was introduced. All fixtures use fake providers/keys and disposable OS-temp data.
