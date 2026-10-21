import type { ProvidersConfig } from "../config/schema.js";
import type { RequestCredential } from "./client.js";
import type { ResolvedProvider } from "./registry.js";
import type { BillingClass, KeyLimits, KeyVault } from "./vault.js";

/**
 * One provider key as routing sees it, whatever its source: the encrypted vault (keys added in
 * the panel or CLI), config (`providers.<id>.keys[]`), or the single keyless credential of a
 * configured provider that runs without a key (`no_key`, Ollama, or a keyless local server).
 * Metadata only; the secret comes from `secret(ref)`.
 */
export interface ProviderCredential {
  /** Stable id: `vault:<id>`, `config:<provider>:env:<VAR>`, `config:<provider>:literal:<n>`, or `none:<provider>`. */
  ref: string;
  source: "vault" | "config" | "none";
  provider: string;
  label: string;
  billingClass: BillingClass;
  enabled: boolean;
  /** Last four characters of the secret for display; "" when unknown (env var unset, keyless). */
  last4: string;
  accountId: string | null;
  quotaGroup: string | null;
  /** Limits configured on this key itself (provider-level limits are on `ResolvedProvider`). */
  limits: KeyLimits;
  vaultKeyId: number | null;
  apiKeyEnv: string | null;
  /** Why the key cannot serve now; null when usable. */
  unusableReason: string | null;
}

type ConfigSecret = { kind: "env"; name: string } | { kind: "literal"; value: string } | { kind: "none" };

/** Merges config-declared keys and vault keys behind one lookup. */
export class ProviderCredentials {
  constructor(
    private readonly providers: ReadonlyMap<string, ResolvedProvider>,
    private readonly section: Pick<ProvidersConfig, "byId">,
    private readonly vault: KeyVault | null,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether a configured provider runs without a key: `no_key` in config, a provider that never
   * takes one (Ollama), or one whose keys are optional (LM Studio, llama.cpp, OVHcloud's anonymous
   * tier) and that has no keys in config or the vault. Only providers with a `providers.<id>`
   * entry get the keyless credential, so an unused local server is never contacted.
   */
  private keyless(id: string, entry: ProvidersConfig["byId"][string]): boolean {
    const policy = this.providers.get(id)?.keyPolicy ?? "required";
    if (entry.no_key || policy === "none") return true;
    return policy === "optional" && entry.keys.length === 0 && !this.vault?.list(id).some((k) => !k.removed);
  }

  private configKeys(providerId?: string): Array<{ cred: ProviderCredential; secret: ConfigSecret }> {
    const out: Array<{ cred: ProviderCredential; secret: ConfigSecret }> = [];
    for (const [id, entry] of Object.entries(this.section.byId)) {
      if (providerId !== undefined && id !== providerId) continue;
      const keyless = this.keyless(id, entry);
      if (keyless) {
        out.push({
          secret: { kind: "none" },
          cred: { ref: `none:${id}`, source: "none", provider: id, label: "no key", billingClass: "free_tier", enabled: true, last4: "", accountId: entry.account_id ?? null, quotaGroup: entry.quota_group ?? null, limits: { rpm: null, rpd: null, tpm: null, tpd: null }, vaultKeyId: null, apiKeyEnv: null, unusableReason: null },
        });
        // A provider that never takes a key ignores configured keys (a proxy in front of it takes `headers`).
        continue;
      }
      for (const [n, k] of entry.keys.entries()) {
        const secret: ConfigSecret = k.api_key_env ? { kind: "env", name: k.api_key_env } : { kind: "literal", value: k.api_key! };
        const value = secret.kind === "env" ? this.env[secret.name] : secret.kind === "literal" ? secret.value : undefined;
        out.push({
          secret,
          cred: {
            ref: secret.kind === "env" ? `config:${id}:env:${secret.name}` : `config:${id}:literal:${n}`,
            source: "config",
            provider: id,
            label: k.label || (secret.kind === "env" ? secret.name : `key ${n + 1}`),
            billingClass: k.billing_class,
            enabled: k.enabled,
            last4: value ? value.slice(-4) : "",
            accountId: k.account_id ?? null,
            quotaGroup: k.quota_group ?? null,
            limits: { rpm: k.rpm ?? null, rpd: k.rpd ?? null, tpm: k.tpm ?? null, tpd: k.tpd ?? null },
            vaultKeyId: null,
            apiKeyEnv: secret.kind === "env" ? secret.name : null,
            unusableReason: !k.enabled ? "disabled in config" : secret.kind === "env" && !value ? `environment variable ${secret.name} is not set` : null,
          },
        });
      }
    }
    return out;
  }

  private vaultKeys(providerId?: string): ProviderCredential[] {
    if (!this.vault) return [];
    const now = this.now();
    return this.vault.list(providerId).map((k) => ({
      ref: `vault:${k.id}`,
      source: "vault" as const,
      provider: k.provider,
      label: k.label || `key ${k.id}`,
      billingClass: k.billingClass,
      enabled: k.enabled,
      last4: k.last4,
      accountId: k.accountId,
      quotaGroup: k.quotaGroup,
      limits: k.limits,
      vaultKeyId: k.id,
      apiKeyEnv: null,
      unusableReason: k.removed ? "removed" : !k.enabled ? "disabled" : k.expiresAt !== null && k.expiresAt <= now ? "expired" : null,
    }));
  }

  private withProviderChecks(c: ProviderCredential): ProviderCredential {
    if (c.unusableReason) return c;
    const p = this.providers.get(c.provider);
    let reason: string | null = null;
    if (!p) reason = `provider ${c.provider} is not configured`;
    else if (!p.enabled) reason = `provider ${c.provider} is disabled`;
    else if (!p.baseUrl) reason = `${c.provider} has no base URL: set providers.${c.provider}.base_url`;
    else if (p.urlParams.includes("account_id") && !(c.accountId ?? p.accountId)) reason = `${c.provider} keys need an account id`;
    return reason ? { ...c, unusableReason: reason } : c;
  }

  /** Every credential (usable or not), config keys first, then vault keys, each in declared order. */
  list(providerId?: string): ProviderCredential[] {
    return [...this.configKeys(providerId).map((k) => k.cred), ...this.vaultKeys(providerId)].map((c) => this.withProviderChecks(c));
  }

  /** Credentials that can serve a request now (before any cooldown or limit state). */
  usable(providerId: string): ProviderCredential[] {
    return this.list(providerId).filter((c) => c.unusableReason === null);
  }

  get(ref: string): ProviderCredential | null {
    const provider = ref.startsWith("vault:") ? this.vault?.get(Number(ref.slice(6)))?.provider : ref.split(":")[1];
    if (!provider) return null;
    return this.list(provider).find((c) => c.ref === ref) ?? null;
  }

  /** The secret and account for a request. Throws for an unknown or unusable credential. */
  requestCredential(ref: string): RequestCredential {
    const cred = this.get(ref);
    if (!cred) throw new Error(`unknown provider credential ${ref}`);
    if (cred.unusableReason) throw new Error(`credential ${ref} cannot be used: ${cred.unusableReason}`);
    const p = this.providers.get(cred.provider)!;
    const accountId = cred.accountId ?? p.accountId;
    if (cred.source === "none") return { apiKey: null, accountId };
    if (cred.source === "vault") return { apiKey: this.vault!.secret(cred.vaultKeyId!), accountId };
    const secret = this.configKeys(cred.provider).find((k) => k.cred.ref === ref)!.secret;
    return { apiKey: secret.kind === "env" ? this.env[secret.name]! : secret.kind === "literal" ? secret.value : null, accountId };
  }
}
