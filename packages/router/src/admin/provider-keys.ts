import { z } from "zod";
import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import type { ProviderStatus } from "../gateway/types.js";
import type { ModelEndpoint } from "../models/catalog.js";
import type { ProviderCredential } from "../providers/credentials.js";
import { freeStatus, listProviderModels } from "../providers/discovery.js";
import type { DiscoveryRun } from "../providers/discovery-run.js";
import { ProviderError, type ProviderErrorKind } from "../providers/errors.js";
import { providerHealth as keyHealth } from "../providers/health.js";
import type { KeyAvailability, KeyState } from "../providers/keys.js";
import { BUILTIN_PROVIDER_IDS, type ProviderApiKind, type ResolvedProvider } from "../providers/registry.js";
import { BillingClassSchema, KeyPatchSchema, NewKeySchema, type BillingClass, type KeyLimits, type KeyPatch, type NewKey, type PaidKey } from "../providers/vault.js";
import { patchConfig } from "./config-edit.js";

/**
 * The panel's Provider keys page: every provider SwitchYard can call (the registry, custom
 * providers from config, and `paid.providers`), every key from the vault and the config with its
 * health from key state, models found per provider, and paid spend per key. Secrets never leave
 * this module: views carry only the last four characters, and key tests redact the secret from
 * provider messages.
 */

const DAY = 86_400_000;

/** What a key can do right now, from its credential and its recorded state. */
export type KeyStatus = "healthy" | "cooling" | "limited" | "invalid" | "out_of_credits" | "disabled" | "removed" | "unusable";

export interface ProviderKeyView {
  /** Stable credential ref (`vault:<id>`, `config:<provider>:env:<VAR>`, `config:<provider>:literal:<n>`, `none:<provider>`). */
  ref: string;
  provider: string;
  source: ProviderCredential["source"];
  /** Where a config key is declared (`providers.groq.keys[0]`); null for vault keys. */
  origin: string | null;
  /** How the secret is supplied, in words: the vault, an environment variable, the config file, or no key. */
  secretSource: string;
  /** Vault keys can be edited, disabled, and removed here; config keys only in the config file. */
  editable: boolean;
  vaultKeyId: number | null;
  label: string;
  billingClass: BillingClass;
  enabled: boolean;
  /** Last four characters of the secret; "" when unknown (env var unset, keyless). */
  last4: string;
  accountId: string | null;
  quotaGroup: string | null;
  limits: KeyLimits;
  status: KeyStatus;
  /** Why the key cannot serve (or what limits it); null when healthy. */
  statusDetail: string | null;
  /** When a cooling, limited, or out-of-credits key is expected back; null when unknown or never without a fix. */
  until: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  /** The last error came after the last success, so it still describes the key. */
  errorCurrent: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  monthlyCapUsd: number | null;
  prepaidBalanceUsd: number | null;
  spent30dUsd: number;
  remainingCapUsd: number | null;
  remainingBalanceUsd: number | null;
}

export type ProviderKind = "builtin" | "custom" | "paid" | "missing";

export interface ProviderKeysEntry {
  id: string;
  displayName: string;
  /** builtin: in the registry; custom: `providers.<id>` with its own base_url; paid: only under `paid.providers`; missing: keys remain for a provider no longer configured. */
  kind: ProviderKind;
  api: ProviderApiKind | null;
  baseUrl: string | null;
  enabled: boolean;
  noKey: boolean;
  /** Keys need an account id (Cloudflare), on the key or the provider. */
  needsAccountId: boolean;
  accountId: string | null;
  /** Declared under `providers.<id>` in the config file. */
  inConfig: boolean;
  /** Declared under `paid.providers.<id>`. */
  inPaid: boolean;
  /** Discovery lists this provider's models (enabled, a usable key, not only a paid provider). */
  discoverable: boolean;
  /** Health from key state; null when the provider has no key at all. */
  health: { status: ProviderStatus["status"]; resumeAt: number | null; requestsRemainingPct: number | null; summary: string } | null;
  keys: ProviderKeyView[];
  /** Catalog endpoints of this provider (discovered, manual, and its configured paid models). */
  models: { total: number; routable: number; free: number; unavailable: number; platform: string };
  sourceUrl: string | null;
}

export interface ProviderKeysView {
  generatedAt: number;
  configPath: string;
  billingClasses: readonly BillingClass[];
  /** Every provider, those with keys first; the page's picker offers every one that takes keys. */
  providers: ProviderKeysEntry[];
  usableKeys: number;
  lastDiscoveryAt: number | null;
}

function keyStatus(cred: ProviderCredential, a: Pick<KeyAvailability, "reason"> | null): KeyStatus {
  if (cred.unusableReason === "removed") return "removed";
  if (cred.unusableReason === "disabled" || cred.unusableReason === "disabled in config") return "disabled";
  if (cred.unusableReason) return "unusable";
  switch (a?.reason ?? null) {
    case null:
      return "healthy";
    case "cooling":
      return "cooling";
    case "auth_invalid":
      return "invalid";
    case "out_of_credits":
      return "out_of_credits";
    case "unusable":
      return "unusable";
    default:
      return "limited";
  }
}

/** Where a config credential is declared, and how its secret arrives. */
function origin(sy: Switchyard, cred: ProviderCredential): { origin: string | null; secretSource: string } {
  if (cred.source === "vault") return { origin: null, secretSource: "encrypted vault" };
  if (cred.source === "none") return { origin: `providers.${cred.provider}.no_key`, secretSource: "no key (local or open server)" };
  const keys = sy.cfg.providers.byId[cred.provider]?.keys ?? [];
  if (cred.apiKeyEnv) {
    const n = keys.findIndex((k) => k.api_key_env === cred.apiKeyEnv);
    return { origin: `providers.${cred.provider}.keys[${n}]`, secretSource: `environment variable ${cred.apiKeyEnv}` };
  }
  const n = Number(cred.ref.split(":").pop());
  return { origin: `providers.${cred.provider}.keys[${n}]`, secretSource: "api_key written in the config file" };
}

function keyView(sy: Switchyard, cred: ProviderCredential, a: KeyAvailability | null, state: KeyState | undefined, vaultKey: PaidKey | undefined, now: number): ProviderKeyView {
  const spent30dUsd = round(sy.spend.keySpendSince(cred.ref, now - 30 * DAY));
  const status = keyStatus(cred, a);
  const lastErrorAt = state?.lastErrorAt ?? null;
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  return {
    ref: cred.ref,
    provider: cred.provider,
    source: cred.source,
    ...origin(sy, cred),
    editable: cred.source === "vault" && !vaultKey?.removed,
    vaultKeyId: cred.vaultKeyId,
    label: cred.label,
    billingClass: cred.billingClass,
    enabled: cred.enabled,
    last4: cred.last4,
    accountId: cred.accountId,
    quotaGroup: cred.quotaGroup,
    limits: cred.limits,
    status,
    statusDetail: status === "healthy" ? null : (cred.unusableReason ?? a?.detail ?? null),
    until: status === "healthy" ? null : (a?.until ?? null),
    lastError: state?.lastError ?? null,
    lastErrorAt,
    lastSuccessAt,
    errorCurrent: lastErrorAt !== null && (lastSuccessAt === null || lastErrorAt > lastSuccessAt),
    createdAt: vaultKey?.createdAt ?? null,
    expiresAt: vaultKey?.expiresAt ?? null,
    monthlyCapUsd: vaultKey?.monthlyCapUsd ?? null,
    prepaidBalanceUsd: vaultKey?.prepaidBalanceUsd ?? null,
    spent30dUsd,
    remainingCapUsd: vaultKey?.monthlyCapUsd != null ? round(vaultKey.monthlyCapUsd - spent30dUsd) : null,
    remainingBalanceUsd: vaultKey?.prepaidBalanceUsd != null ? round(vaultKey.prepaidBalanceUsd - sy.spend.keySpendSince(cred.ref, vaultKey.balanceCheckedAt ?? 0)) : null,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** One line on what a provider's keys can do now; never an error that a later success resolved. */
function healthSummary(status: ProviderStatus, keys: ProviderKeyView[]): string {
  const usable = keys.filter((k) => !["disabled", "removed", "unusable"].includes(k.status));
  const count = (s: KeyStatus) => usable.filter((k) => k.status === s).length;
  const parts = ([
    ["cooling", "cooling down"],
    ["limited", "at a limit"],
    ["invalid", "invalid"],
    ["out_of_credits", "out of credits"],
  ] as const)
    .map(([s, label]) => (count(s) ? `${count(s)} ${label}` : null))
    .filter((x): x is string => x !== null);
  const ready = count("healthy");
  switch (status.status) {
    case "healthy":
      return ready === usable.length ? `${ready === 1 ? "The key is" : `All ${ready} keys are`} ready` : `${ready} of ${usable.length} keys ready; ${parts.join(", ")}`;
    case "rate_limited":
      return `No key can serve now: ${parts.join(", ")}`;
    case "invalid":
      return `Every key needs attention: ${parts.join(", ")}`;
    default:
      return usable.length ? "No usable key" : "No usable key: every key is disabled, removed, or missing its secret";
  }
}

function modelCounts(eps: ModelEndpoint[], id: string): ProviderKeysEntry["models"] {
  const mine = eps.filter((e) => e.providerId === id || e.providerId === `paid:${id}`);
  return {
    total: mine.length,
    routable: mine.filter((e) => e.status === "active" && e.available).length,
    free: mine.filter((e) => e.pricing.freeVerified).length,
    unavailable: mine.filter((e) => !e.available).length,
    /** The models page filter value: the provider id, or `paid:<id>` when only configured paid models exist. */
    platform: mine.length && mine.every((e) => e.providerId === `paid:${id}`) ? `paid:${id}` : id,
  };
}

/** Everything the Provider keys page shows. No secret is included. */
export function providerKeysView(sy: Switchyard): ProviderKeysView {
  const now = sy.providers.now();
  const providers = sy.providers.providers();
  const creds = sy.providers.credentials().list();
  const vault = new Map(sy.vault.list().map((k) => [k.id, k]));
  const discoverable = new Set(sy.providers.discoverable());
  const eps = sy.catalog.endpoints();
  const ids = new Set([...providers.keys(), ...creds.map((c) => c.provider)]);
  const entries: ProviderKeysEntry[] = [];
  for (const id of ids) {
    const p = providers.get(id) ?? null;
    const mine = creds.filter((c) => c.provider === id);
    const states = sy.providers.keys.states(mine.map((c) => c.ref));
    let health: ProviderKeysEntry["health"] = null;
    let keys: ProviderKeyView[];
    if (p) {
      const detail = keyHealth(p, mine, sy.providers.keys, { limits: sy.providers.limits });
      const byRef = new Map(detail.keys.map((a) => [a.ref, a]));
      keys = mine.map((c) => keyView(sy, c, byRef.get(c.ref) ?? null, states.get(c.ref), c.vaultKeyId !== null ? vault.get(c.vaultKeyId) : undefined, now));
      if (mine.length) health = { status: detail.status.status, resumeAt: detail.status.resumeAt, requestsRemainingPct: detail.status.requestsRemainingPct, summary: healthSummary(detail.status, keys) };
    } else {
      keys = mine.map((c) => keyView(sy, c, null, states.get(c.ref), c.vaultKeyId !== null ? vault.get(c.vaultKeyId) : undefined, now));
    }
    const inConfig = Object.hasOwn(sy.cfg.providers.byId, id);
    const inPaid = Object.hasOwn(sy.cfg.paid.providers, id);
    const builtIn = BUILTIN_PROVIDER_IDS.includes(id);
    entries.push({
      id,
      displayName: p?.displayName ?? id,
      kind: !p ? "missing" : builtIn && p.builtIn ? "builtin" : inConfig ? "custom" : inPaid ? "paid" : "custom",
      api: p?.api ?? null,
      baseUrl: p?.baseUrl ?? null,
      enabled: p?.enabled ?? false,
      noKey: p?.noKey ?? false,
      needsAccountId: p?.urlParams.includes("account_id") ?? false,
      accountId: p?.accountId ?? null,
      inConfig,
      inPaid,
      discoverable: discoverable.has(id),
      health,
      keys,
      models: modelCounts(eps, id),
      sourceUrl: p?.sourceUrl.startsWith("http") ? p.sourceUrl : null,
    });
  }
  entries.sort((a, b) => Number(b.keys.length > 0) - Number(a.keys.length > 0) || a.displayName.localeCompare(b.displayName));
  const last = sy.db.prepare("SELECT value FROM meta WHERE key = 'provider_discovery_last'").get() as { value: string } | undefined;
  return {
    generatedAt: now,
    configPath: sy.cfg.configPath,
    billingClasses: BillingClassSchema.options,
    providers: entries,
    usableKeys: creds.filter((c) => c.unusableReason === null).length,
    lastDiscoveryAt: last ? Number(last.value) : null,
  };
}

/** One key's view by ref (null when no credential has that ref). */
export function providerKeyView(sy: Switchyard, ref: string): ProviderKeyView | null {
  for (const p of providerKeysView(sy).providers) for (const k of p.keys) if (k.ref === ref) return k;
  return null;
}

function bad(message: string): SwitchyardError {
  return new SwitchyardError("config_invalid", message);
}

function vaultKey(sy: Switchyard, id: number): PaidKey {
  const k = sy.vault.get(id);
  if (!k) throw new SwitchyardError("not_found", `unknown key ${id}`);
  return k;
}

/** The provider a key would be added to, refusing providers that cannot take one. */
function keyProvider(sy: Switchyard, id: string, accountId: string | null): ResolvedProvider {
  const p = sy.providers.provider(id);
  if (!p) throw bad(`unknown provider ${id}: pick a built-in provider (${BUILTIN_PROVIDER_IDS.join(", ")}) or add a custom one first`);
  if (p.noKey) throw bad(`${id} is configured with no_key: it takes no key`);
  if (p.urlParams.includes("account_id") && !(accountId ?? p.accountId)) throw bad(`${p.displayName} keys need an account id`);
  return p;
}

/**
 * Add a key to the encrypted vault for any registry provider, custom provider from config, or
 * provider under `paid.providers`. Returns the key's view (last four characters only).
 */
export function addProviderKey(sy: Switchyard, input: NewKey): ProviderKeyView {
  const k = NewKeySchema.parse(input);
  keyProvider(sy, k.provider, k.accountId);
  const added = sy.vault.add(k);
  return providerKeyView(sy, `vault:${added.id}`)!;
}

/**
 * Edit a vault key. A new secret or re-enabling the key clears its recorded disable and
 * cooldown, so the next request tries it again. A removed key (secret wiped, kept for spend
 * history) cannot be edited.
 */
export function updateProviderKey(sy: Switchyard, id: number, patch: KeyPatch): ProviderKeyView {
  const current = vaultKey(sy, id);
  if (current.removed) throw bad(`key ${id} was removed (its secret is gone); add a new key instead`);
  const p = KeyPatchSchema.parse(patch);
  if (p.accountId !== undefined) keyProvider(sy, current.provider, p.accountId);
  sy.vault.update(id, p);
  if (p.secret !== undefined || p.enabled === true) sy.providers.keys.clear(`vault:${id}`);
  return providerKeyView(sy, `vault:${id}`)!;
}

/** Remove a vault key. One with recorded paid spend keeps its row (secret wiped, disabled) so spend history stays complete. */
export function removeProviderKey(sy: Switchyard, id: number): { removed: number; keptForHistory: boolean } {
  vaultKey(sy, id);
  sy.vault.remove(id);
  sy.providers.keys.forget(`vault:${id}`);
  return { removed: id, keptForHistory: sy.vault.get(id) !== null };
}

// ---------- key tests ----------

const AccountId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Test a stored key by ref, or a pasted key before it is saved. */
export const KeyTestSchema = z.union([
  z.object({ ref: z.string().min(1).max(300) }).strict(),
  z
    .object({
      provider: z.string().regex(/^[a-z0-9-]+$/),
      secret: z.string().min(8).max(4000),
      accountId: AccountId.nullable().default(null),
      billingClass: BillingClassSchema.default("free_tier"),
    })
    .strict(),
]);
export type KeyTestInput = z.input<typeof KeyTestSchema>;

export interface KeyTestModel {
  id: string;
  displayName: string | null;
  contextLimitTokens: number | null;
  /** Free with this key's billing class (a $0 or `:free` model, or any model through a free_tier key). */
  free: boolean;
  freeReason: string;
}

export interface KeyTestResult {
  ok: boolean;
  provider: string;
  ref: string | null;
  /** Models the key can use, as the provider lists them. */
  models: KeyTestModel[];
  /** Listed models left out (not chat models, or priced models a free key cannot reach). */
  excluded: Array<{ model: string; reason: string }>;
  pages: number;
  error: { kind: ProviderErrorKind | "error"; message: string } | null;
  durationMs: number;
}

const redact = (text: string, secret: string | null) => (secret && secret.length >= 4 ? text.split(secret).join("••••") : text);

/**
 * List the models a key can use with the provider's model list (no chat request, no quota for
 * completions). A stored key that the provider rejects as invalid is recorded as such; one that
 * lists successfully while recorded as invalid is cleared. Never throws for a provider failure.
 */
export async function testProviderKey(sy: Switchyard, input: KeyTestInput): Promise<KeyTestResult> {
  const t = KeyTestSchema.parse(input);
  const started = sy.providers.now();
  let provider: ResolvedProvider;
  let credential: { apiKey: string | null; accountId: string | null };
  let cred: ProviderCredential | null = null;
  let billing: BillingClass;
  if ("ref" in t) {
    cred = sy.providers.credentials().get(t.ref);
    if (!cred) throw new SwitchyardError("not_found", `unknown key ${t.ref}`);
    const p = sy.providers.provider(cred.provider);
    const fail = (message: string): KeyTestResult => ({ ok: false, provider: cred!.provider, ref: cred!.ref, models: [], excluded: [], pages: 0, error: { kind: "error", message }, durationMs: 0 });
    if (!p) return fail(`provider ${cred.provider} is not configured`);
    if (cred.unusableReason) return fail(`this key cannot be used: ${cred.unusableReason}`);
    provider = p;
    const rc = sy.providers.credentials().requestCredential(cred.ref);
    credential = { apiKey: rc.apiKey, accountId: rc.accountId ?? p.accountId };
    billing = cred.billingClass;
  } else {
    provider = keyProvider(sy, t.provider, t.accountId);
    credential = { apiKey: t.secret, accountId: t.accountId ?? provider.accountId };
    billing = t.billingClass;
  }
  const timeoutMs = Math.min(30_000, sy.cfg.providers.request_timeout_seconds * 1000);
  try {
    const listing = await listProviderModels(sy.providers.fetch, provider, credential, { timeoutMs, now: sy.providers.now });
    const models: KeyTestModel[] = [];
    const excluded = [...listing.excluded];
    for (const m of listing.models) {
      const f = freeStatus(provider, m, [{ billingClass: billing }]);
      if (!f.usable) excluded.push({ model: m.id, reason: f.reason });
      else models.push({ id: m.id, displayName: m.displayName, contextLimitTokens: m.contextLimitTokens, free: f.value, freeReason: f.reason });
    }
    if (cred && sy.providers.keys.get(cred.ref)?.disabledReason === "auth_invalid") sy.providers.keys.clear(cred.ref);
    return { ok: true, provider: provider.id, ref: cred?.ref ?? null, models, excluded, pages: listing.pages, error: null, durationMs: sy.providers.now() - started };
  } catch (err) {
    if (cred && err instanceof ProviderError && err.reason === "auth_invalid") sy.providers.keys.recordFailure(cred, err);
    return {
      ok: false,
      provider: provider.id,
      ref: cred?.ref ?? null,
      models: [],
      excluded: [],
      pages: 0,
      error: { kind: err instanceof ProviderError ? err.reason : "error", message: redact((err as Error).message ?? String(err), credential.apiKey) },
      durationMs: sy.providers.now() - started,
    };
  }
}

// ---------- discovery for one provider ----------

export interface ProviderScanResult {
  provider: string;
  status: "listed" | "no_key" | "disabled" | "failed";
  kept: number;
  added: string[];
  errors: string[];
  warnings: string[];
}

/** List and save one provider's models now (the page's "Find models"). */
export async function scanProviderModels(sy: Switchyard, id: string): Promise<ProviderScanResult> {
  const p = sy.providers.provider(id);
  if (!p) throw new SwitchyardError("not_found", `unknown provider ${id}`);
  if (!sy.providers.discoverable().includes(id)) {
    if (!Object.hasOwn(sy.cfg.providers.byId, id) && !p.builtIn && Object.hasOwn(sy.cfg.paid.providers, id)) throw bad(`${id} is only a paid provider: it routes the models listed under paid.models`);
    throw bad(`${p.displayName} has no usable key${p.enabled ? "" : " (the provider is disabled)"}`);
  }
  const run: DiscoveryRun | null = await sy.discover({ only: [id] });
  const d = run?.providers.find((x) => x.provider === id);
  return {
    provider: id,
    status: d?.status ?? "no_key",
    kept: d?.kept ?? 0,
    added: (run?.added ?? []).filter((a) => a.startsWith(`${id}/`)),
    errors: (d?.errors ?? []).map((e) => `${e.ref}: ${e.message}`),
    warnings: run?.warnings ?? [],
  };
}

// ---------- custom providers ----------

export const CustomProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits, and dashes"),
    displayName: z.string().trim().min(1).max(80).optional(),
    baseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "the base URL must start with http:// or https://"),
    api: z.enum(["openai_compatible", "anthropic"]).default("openai_compatible"),
    /** A local or open server that takes no key (Ollama, llama.cpp, vLLM, LM Studio). */
    noKey: z.boolean().default(false),
    modelsPath: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CustomProviderInput = z.input<typeof CustomProviderSchema>;

/** Add an OpenAI-compatible (or Anthropic-style) provider under `providers.<id>` in the config file. */
export function addCustomProvider(sy: Switchyard, input: CustomProviderInput): { id: string } {
  const c = CustomProviderSchema.parse(input);
  if (BUILTIN_PROVIDER_IDS.includes(c.id)) throw bad(`${c.id} is a built-in provider: add its key directly`);
  if (Object.hasOwn(sy.cfg.providers.byId, c.id)) throw bad(`${c.id} is already configured`);
  if (Object.hasOwn(sy.cfg.paid.providers, c.id)) throw bad(`${c.id} is already a paid provider: pick another id`);
  const entry: Record<string, unknown> = { base_url: c.baseUrl.replace(/\/+$/, "") };
  if (c.displayName) entry.display_name = c.displayName;
  if (c.api !== "openai_compatible") entry.api = c.api;
  if (c.noKey) entry.no_key = true;
  if (c.modelsPath) entry.models_path = c.modelsPath;
  const r = patchConfig(sy, [{ path: ["providers", c.id], value: entry }]);
  if (!r.ok) throw bad(r.errors.join("; "));
  return { id: c.id };
}

/** Remove a custom provider from the config file once it has no keys left. */
export function removeCustomProvider(sy: Switchyard, id: string): { removed: string } {
  const e = sy.cfg.providers.byId[id];
  if (!e || BUILTIN_PROVIDER_IDS.includes(id)) throw new SwitchyardError("not_found", `${id} is not a custom provider in the config`);
  if (e.keys.length) throw bad(`${id} has keys in the config file: remove them there first`);
  if (sy.vault.list(id).some((k) => !k.removed)) throw bad(`remove ${id}'s keys first`);
  const r = patchConfig(sy, [{ path: ["providers", id], value: null }]);
  if (!r.ok) throw bad(r.errors.join("; "));
  return { removed: id };
}

// ---------- paid spend ----------

/** Paid routing at a glance: the master switch, tier policies, and spend against budgets. */
export function paidSummary(sy: Switchyard) {
  const s = sy.spend.summary();
  return {
    enabled: sy.cfg.paid.enabled,
    tiers: sy.cfg.paid.tiers,
    providers: Object.keys(sy.cfg.paid.providers),
    maxPaidAttempts: sy.cfg.paid.max_paid_attempts,
    day: s.day,
    week: s.week,
    month: s.month,
    budgets: s.budgets,
    byEndpoint: s.byEndpoint,
  };
}
