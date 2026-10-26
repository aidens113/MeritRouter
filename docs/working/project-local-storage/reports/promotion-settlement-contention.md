# Promotion settlement contention

Brain compatibility investigation established a real failure: an independent reviewer
completed in112ms and emitted its settled event, but automatic promotion publication hit
RepositoryMutationError lock_busy. The service callback discarded that error, leaving its
durable pending review without another settlement notification. This is not a provider failure.

Brain worker now serializes ordinary effects by physical common Git owner before acquiring
the lifecycle scope. The service additionally retries ONLY transient lock_busy settlement,
up to five retries after the initial attempt with bounded250/500/1000/2000/4000ms delays.
It reuses the durable review result; it does not submit another review/model request.
Existing tracked timers cancel onclose. Pending publication and unverified command errors
are not retried automatically; their evidence remains for explicit recovery.

Root event/timer integration tests3/3 PASS4.08s: successful transient retry, unresolved
publication refusal, bounded attempts and close cancellation. Full real-provider-shaped fake
promotion regression remains with Brain worker; no live call or altered product deadline.
