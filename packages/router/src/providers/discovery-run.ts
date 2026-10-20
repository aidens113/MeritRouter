import type { RawConfig } from "../config/schema.js";
import type { Catalog } from "../models/catalog.js";
import type { ProviderClient } from "./client.js";
import { discoverModels, type DiscoveryResult } from "./discovery.js";
import type { ProbeBudget } from "./enrich.js";
import type { ProviderRuntime } from "./runtime.js";

/** One discovery run as persisted: what was found, saved, newly added, and skipped. */
export interface DiscoveryRun extends DiscoveryResult {
  startedAt: number;
  finishedAt: number;
  /** Endpoint ids not stored before this run. */
  added: string[];
  saved: number;
  /** Ids held by a FreeLLMAPI chain row, left alone until chains are removed. */
  skipped: string[];
}

export interface DiscoveryRunOptions {
  runtime: ProviderRuntime;
  catalog: Catalog;
  config: Pick<RawConfig["discovery"], "openrouter_models_url" | "huggingface_api_url" | "probe_tools" | "max_probe_requests_per_day">;
  /** Provider ids to list (default: every discoverable provider). */
  only?: readonly string[];
  /** Gate-backed client for the opt-in tool probe (see Gate.probeClient). */
  probeClient?: Pick<ProviderClient, "complete"> | null;
  probeBudget?: ProbeBudget;
  signal?: AbortSignal;
}

/**
 * List and enrich the models of providers with usable keys, then save them per provider: a
 * provider whose listing succeeded has its unlisted models marked unavailable; a provider whose
 * listing failed, and every other provider, keep their stored rows.
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
    ...(o.probeClient ? { probeClient: o.probeClient } : {}),
    ...(o.probeBudget ? { probeBudget: o.probeBudget } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const listed = result.providers.filter((p) => p.status === "listed").map((p) => p.provider);
  const before = new Set(known.map((e) => e.id));
  const save = o.catalog.saveProviderDiscovery([...result.endpoints.map((e) => e.endpoint), ...result.unavailable.map((u) => u.endpoint)], listed, o.runtime.now());
  const skipped = new Set(save.skipped);
  return {
    ...result,
    startedAt,
    finishedAt: o.runtime.now(),
    added: result.endpoints.map((e) => e.endpoint.id).filter((id) => !before.has(id) && !skipped.has(id)),
    saved: save.saved,
    skipped: save.skipped,
  };
}
