import type { ProvidersConfig } from "../config/schema.js";
import { ProviderEntrySchema, type PaidProviderConfig } from "../config/schema.js";
import type { ProviderStatus } from "../gateway/types.js";
import type { Db } from "../storage/db.js";
import { createProviderClient, type ProviderClient } from "./client.js";
import { ProviderCredentials } from "./credentials.js";
import { providerStatuses } from "./health.js";
import { ProviderKeys } from "./keys.js";
import { ProviderLimits } from "./limits.js";
import { builtinProvider, customProvider, defaultProvider, resolveProviders, type ResolvedProvider } from "./registry.js";
import type { FetchLike } from "./transport.js";
import type { KeyVault } from "./vault.js";

/**
 * A provider from the `paid.providers` section as a direct provider: generic OpenAI-compatible
 * (OpenRouter's body extras when the URL is openrouter.ai) or Anthropic Messages at `<base>/v1`.
 */
export function paidProviderAsDirect(name: string, cfg: PaidProviderConfig): ResolvedProvider {
  const base = cfg.base_url.replace(/\/+$/, "");
  if (cfg.kind === "anthropic") return { ...defaultProvider("anthropic")!, id: name, baseUrl: `${base}/v1` };
  const p = customProvider(name, ProviderEntrySchema.parse({ base_url: base }));
  return /openrouter\.ai/.test(base) ? { ...p, bodyExtras: builtinProvider("openrouter")!.bodyExtras } : p;
}

/**
 * Every provider a direct endpoint can name: the registry's built-ins and custom providers
 * (`providers:`), plus each `paid.providers` entry. A paid entry named like a registry provider
 * uses the registry definition when it points at the same base URL, else its own.
 */
export function routingProviders(
  section: Pick<ProvidersConfig, "byId">,
  paid: Readonly<Record<string, PaidProviderConfig>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { providers: Map<string, ResolvedProvider>; fromPaid: Set<string> } {
  const providers = resolveProviders(section, env);
  const fromPaid = new Set<string>();
  for (const [name, p] of Object.entries(paid)) {
    const converted = paidProviderAsDirect(name, p);
    const known = providers.get(name);
    if (!known || known.baseUrl.replace(/\/+$/, "") !== converted.baseUrl) {
      providers.set(name, converted);
      fromPaid.add(name);
    }
  }
  return { providers, fromPaid };
}

export interface ProviderRuntimeConfig {
  providers: ProvidersConfig;
  paid: { providers: Record<string, PaidProviderConfig> };
}

export interface ProviderRuntimeOptions {
  /** The provider HTTP client; defaults to one over `fetch`. */
  client?: ProviderClient;
  /** Injectable fetch for the default client and discovery (tests use a fake provider). */
  fetch?: FetchLike;
  now?: () => number;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The direct-provider runtime one process shares: resolved providers and credentials (rebuilt
 * when a config reload replaces the `providers` or `paid.providers` sections), per-key state,
 * configured limits, the HTTP client, and health derived from key state.
 */
export class ProviderRuntime {
  readonly keys: ProviderKeys;
  readonly limits: ProviderLimits;
  readonly client: ProviderClient;
  readonly fetch: FetchLike;
  readonly now: () => number;
  private cache: { section: unknown; paid: unknown; providers: Map<string, ResolvedProvider>; fromPaid: Set<string>; credentials: ProviderCredentials } | null = null;

  constructor(
    private readonly cfg: ProviderRuntimeConfig,
    db: Db,
    readonly vault: KeyVault | null,
    private readonly opts: ProviderRuntimeOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.keys = new ProviderKeys(db, this.now);
    this.limits = new ProviderLimits(db, this.now);
    this.client = opts.client ?? createProviderClient({ fetch: this.fetch, now: this.now });
  }

  private current(): NonNullable<ProviderRuntime["cache"]> {
    const section = this.cfg.providers;
    const paid = this.cfg.paid.providers;
    if (this.cache?.section !== section || this.cache.paid !== paid) {
      const env = this.opts.env ?? process.env;
      const { providers, fromPaid } = routingProviders(section, paid, env);
      this.cache = { section, paid, providers, fromPaid, credentials: new ProviderCredentials(providers, section, this.vault, env, this.now) };
    }
    return this.cache;
  }

  providers(): ReadonlyMap<string, ResolvedProvider> {
    return this.current().providers;
  }

  provider(id: string): ResolvedProvider | null {
    return this.current().providers.get(id) ?? null;
  }

  credentials(): ProviderCredentials {
    return this.current().credentials;
  }

  /**
   * Providers whose models discovery lists: registry and `providers:` entries that are enabled
   * and have a usable credential. Providers declared only under `paid.providers` route the
   * models configured in `paid.models` and are not listed.
   */
  discoverable(): string[] {
    const { providers, fromPaid } = this.current();
    return [...providers.values()].filter((p) => p.enabled && !fromPaid.has(p.id) && this.credentials().usable(p.id).length > 0).map((p) => p.id);
  }

  /**
   * Health of every provider that has a credential, from key state and configured limits: one
   * entry per provider. Configured paid endpoints use the platform `paid:<name>`; they read
   * their provider's entry through `statusPlatform`.
   */
  statuses(): ProviderStatus[] {
    return providerStatuses(this.providers(), this.credentials().list(), this.keys, { limits: this.limits });
  }

  /**
   * The provider whose key-derived status a platform name reads: `paid:<name>` (the platform of
   * the endpoints configured under `paid.models`) reads `<name>` when `<name>` is a
   * `paid.providers` entry; every other name reads itself.
   */
  statusPlatform(platform: string): string {
    if (!platform.startsWith("paid:")) return platform;
    const name = platform.slice("paid:".length);
    return Object.hasOwn(this.cfg.paid.providers, name) ? name : platform;
  }
}
