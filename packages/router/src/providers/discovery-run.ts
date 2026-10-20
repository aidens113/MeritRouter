import type { RawConfig } from "../config/schema.js";
import type { Catalog } from "../models/catalog.js";
import type { ProviderClient } from "./client.js";
import { discoverModels, type DiscoveryResult } from "./discovery.js";
import type { ProbeBudget } from "./enrich.js";
import { ProviderError } from "./errors.js";
import { probeFreeDailyQuota } from "./limits.js";
import type { ProviderRuntime } from "./runtime.js";

/** One discovery run as persisted: what was found, saved, newly added, and skipped. */
export interface DiscoveryRun extends DiscoveryResult {
  startedAt: number;
  finishedAt: number;
  /** Endpoint ids not stored before this run. */
  added: string[];
  saved: number;
  /** Credential refs whose free daily quota was refreshed (OpenRouter's key-info endpoint). */
  quotasRefreshed: string[];
}

export interface DiscoveryRunOptions {
  runtime: ProviderRuntime;
  catalog: Catalog;
  config: Pick<RawConfig["discovery"], "openrouter_models_url" | "huggingface_api_url" | "probe_tools" | "max_probe_requests_per_day">;
  /** Provider ids to list (default: every discoverable provider). */
  only?: readonly string[];
  /** Refresh free daily quotas of the listed providers' keys (default true). */
  refreshQuotas?: boolean;
  /** Gate-backed client for the opt-in tool probe (see Gate.probeClient). */
  probeClient?: Pick<ProviderClient, "complete"> | null;
  probeBudget?: ProbeBudget;
  signal?: AbortSignal;
}

/**
 * Ask the key-info endpoint of each provider in `only` that has one (OpenRouter) for every usable
 * key's free daily quota and store it on the key, so key selection sees the quota before the
 * provider refuses. A key the endpoint rejects as invalid is recorded as such; other failures are
 * returned as warnings and leave the stored quota alone.
 */
export async function refreshFreeQuotas(runtime: ProviderRuntime, only: readonly string[], signal?: AbortSignal): Promise<{ refreshed: string[]; warnings: string[] }> {
  const out = { refreshed: [] as string[], warnings: [] as string[] };
  for (const id of only) {
    const provider = runtime.provider(id);
    if (!provider?.enabled || !provider.keyInfoUrl) continue;
    for (const cred of runtime.credentials().usable(id)) {
      try {
        const quota = await probeFreeDailyQuota({ provider, credential: runtime.credentials().requestCredential(cred.ref), fetch: runtime.fetch, now: runtime.now, ...(signal ? { signal } : {}) });
        if (!quota) continue;
        runtime.keys.recordQuota(cred, quota);
        out.refreshed.push(cred.ref);
      } catch (err) {
        if (err instanceof ProviderError && err.reason === "auth_invalid") runtime.keys.recordFailure(cred, err);
        out.warnings.push(`${id} (${cred.ref}) free daily quota: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

/**
 * List and enrich the models of providers with usable keys, then save them per provider: a
 * provider whose listing succeeded has its unlisted models marked unavailable; a provider whose
 * listing failed, and every other provider, keep their stored rows. Free daily quotas of the
 * listed providers' keys are refreshed in the same run.
 */
export async function runProviderDiscovery(o: DiscoveryRunOptions): Promise<DiscoveryRun> {
  const startedAt = o.runtime.now();
  const only = o.only ?? o.runtime.discoverable();
  const known = o.catalog.storedEndpoints();
  const result = await discoverModels({
    providers: o.runtime.providers(),
    credentials: o.runtime.credentials(),
    config: o.config,
    only,
    fetch: o.runtime.fetch,
    now: o.runtime.now,
    known,
    manual: o.catalog.manualEndpoints(),
    overrides: o.catalog.mergedOverrides(),
    // A key the listing shows is revoked or out of credits is switched off, as a request would.
    onKeyFailure: (cred, err) => o.runtime.keys.recordFailure(cred, err),
    ...(o.probeClient ? { probeClient: o.probeClient } : {}),
    ...(o.probeBudget ? { probeBudget: o.probeBudget } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const listed = result.providers.filter((p) => p.status === "listed").map((p) => p.provider);
  const before = new Set(known.map((e) => e.id));
  const save = o.catalog.saveProviderDiscovery([...result.endpoints.map((e) => e.endpoint), ...result.unavailable.map((u) => u.endpoint)], listed, o.runtime.now());
  const quotas = o.refreshQuotas === false ? { refreshed: [], warnings: [] } : await refreshFreeQuotas(o.runtime, only, o.signal);
  return {
    ...result,
    warnings: [...result.warnings, ...quotas.warnings],
    startedAt,
    finishedAt: o.runtime.now(),
    added: result.endpoints.map((e) => e.endpoint.id).filter((id) => !before.has(id)),
    saved: save.saved,
    quotasRefreshed: quotas.refreshed,
  };
}
