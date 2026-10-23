import type { ProviderCredential } from "./credentials.js";
import { listProviderModels, type ProviderListing } from "./discovery.js";
import { isKeyFailure, ProviderError, type ProviderErrorKind } from "./errors.js";
import type { ResolvedProvider } from "./registry.js";
import type { ProviderRuntime } from "./runtime.js";

/**
 * Testing a key: list the provider's models with it (no chat request, no completion quota). The
 * panel's Test button and `meritrouter keys test` / `keys add --test` both use this, so a stored
 * key's state changes the same way from either: a key the provider rejects (or reports out of
 * credits) is recorded as a failed request would record it, and a key recorded as invalid whose
 * listing now works is cleared. Error messages arrive with secrets already masked by the
 * transport.
 */

/** Model listings in a key test give up after this long (the bound discovery uses). */
export const KEY_TEST_TIMEOUT_MS = 30_000;

/** The listing timeout for a key test: the discovery bound, or the configured request timeout if shorter. */
export const keyTestTimeoutMs = (requestTimeoutSeconds: number): number => Math.min(KEY_TEST_TIMEOUT_MS, requestTimeoutSeconds * 1000);

/** A stored credential (its key state is updated), or a secret that is not stored yet (nothing is recorded). */
export type KeyTestTarget = { credential: ProviderCredential } | { provider: ResolvedProvider; secret: string; accountId: string | null };

export interface KeyTestOutcome {
  provider: string;
  /** The stored credential's ref; null for a secret that is not stored. */
  ref: string | null;
  ok: boolean;
  /** Why a stored key was not tested (disabled, env var unset, provider not configured): nothing was sent. */
  skipped: string | null;
  /** The listing, when it succeeded. */
  listing: ProviderListing | null;
  error: { kind: ProviderErrorKind | "error"; message: string } | null;
  /** The stored key had been recorded as invalid and listed now, so the mark was cleared. */
  cleared: boolean;
  durationMs: number;
}

export type KeyTestRuntime = Pick<ProviderRuntime, "fetch" | "now" | "keys" | "credentials" | "provider">;

/** Test one key by listing its provider's models. Never throws for a provider failure. */
export async function testKeyListing(runtime: KeyTestRuntime, target: KeyTestTarget, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<KeyTestOutcome> {
  const stored = "credential" in target ? target.credential : null;
  const base = { provider: stored?.provider ?? (target as { provider: ResolvedProvider }).provider.id, ref: stored?.ref ?? null, ok: false, skipped: null, listing: null, error: null, cleared: false, durationMs: 0 };
  let provider: ResolvedProvider;
  let credential: { apiKey: string | null; accountId: string | null };
  if (stored) {
    const p = runtime.provider(stored.provider);
    if (stored.unusableReason || !p) return { ...base, skipped: stored.unusableReason ?? `provider ${stored.provider} is not configured` };
    provider = p;
    const rc = runtime.credentials().requestCredential(stored.ref);
    credential = { apiKey: rc.apiKey, accountId: rc.accountId ?? p.accountId };
  } else {
    const t = target as Extract<KeyTestTarget, { secret: string }>;
    provider = t.provider;
    credential = { apiKey: t.secret, accountId: t.accountId ?? t.provider.accountId };
  }
  const started = runtime.now();
  try {
    const listing = await listProviderModels(runtime.fetch, provider, credential, { timeoutMs: opts.timeoutMs ?? KEY_TEST_TIMEOUT_MS, now: runtime.now, ...(opts.signal ? { signal: opts.signal } : {}) });
    const cleared = stored !== null && runtime.keys.get(stored.ref)?.disabledReason === "auth_invalid";
    if (cleared) runtime.keys.clear(stored.ref);
    return { ...base, ok: true, listing, cleared, durationMs: runtime.now() - started };
  } catch (err) {
    if (stored && isKeyFailure(err)) runtime.keys.recordFailure(stored, err);
    return { ...base, error: { kind: err instanceof ProviderError ? err.reason : "error", message: (err as Error).message ?? String(err) }, durationMs: runtime.now() - started };
  }
}
