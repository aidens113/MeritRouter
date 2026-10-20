import { z } from "zod";
import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import type { ProviderErrorKind } from "../providers/errors.js";
import { providerHealth } from "../providers/health.js";
import { keyTestTimeoutMs, testKeyListing, type KeyTestOutcome } from "../providers/key-test.js";
import type { ProviderCredential } from "../providers/credentials.js";
import type { KeyAvailability } from "../providers/keys.js";
import type { ResolvedProvider } from "../providers/registry.js";
import { BillingClassSchema, NewKeySchema, type PaidKey } from "../providers/vault.js";
import { countFlag } from "./args.js";
import { readHiddenLine } from "./secret-input.js";
import { out, stamp, table } from "./terminal.js";

// `switchyard keys`: provider keys in the vault (added here or in the panel) and keys declared in
// the config, for every built-in, custom, and paid provider. Secrets are read from the
// environment or a hidden prompt, never from argv, and only their last four characters are shown.

/** Environment variable `keys add` reads the new secret from. */
export const NEW_KEY_ENV = "SWITCHYARD_NEW_KEY";

export type KeyStatus = "available" | "unusable" | "invalid" | "out_of_credits" | "cooling" | "exhausted" | "free_quota" | "limit";

/** One key as `keys list` reports it. */
export interface KeyRow {
  ref: string;
  provider: string;
  label: string;
  source: ProviderCredential["source"];
  billingClass: ProviderCredential["billingClass"];
  enabled: boolean;
  /** Last four characters of the secret; "" when unknown (env var unset, keyless provider). */
  last4: string;
  status: KeyStatus;
  /** When the key is expected back (ISO), for cooling, exhausted, quota, limit, out of credits. */
  until: string | null;
  detail: string | null;
  vaultKeyId: number | null;
  apiKeyEnv: string | null;
}

const STATUS: Record<NonNullable<KeyAvailability["reason"]>, KeyStatus> = {
  unusable: "unusable",
  excluded: "available",
  auth_invalid: "invalid",
  out_of_credits: "out_of_credits",
  cooling: "cooling",
  exhausted: "exhausted",
  free_quota: "free_quota",
  limit: "limit",
};

/** Availability of every credential (of one provider, or all), from key state and configured limits. */
export function keyAvailability(sy: Switchyard, providerId?: string): Array<{ cred: ProviderCredential; availability: KeyAvailability }> {
  const creds = sy.providers.credentials().list(providerId);
  const byRef = new Map<string, KeyAvailability>();
  for (const id of new Set(creds.map((c) => c.provider))) {
    const provider = sy.providers.provider(id);
    if (!provider) continue;
    for (const a of providerHealth(provider, creds, sy.providers.keys, { limits: sy.providers.limits }).keys) byRef.set(a.ref, a);
  }
  return creds.map((cred) => ({
    cred,
    availability: byRef.get(cred.ref) ?? { ref: cred.ref, available: false, reason: "unusable", until: null, detail: cred.unusableReason ?? `provider ${cred.provider} is not configured` },
  }));
}

/** Every vault and config key with its status (`keys list`). */
export function keyRows(sy: Switchyard, providerId?: string): KeyRow[] {
  return keyAvailability(sy, providerId).map(({ cred, availability: a }) => ({
    ref: cred.ref,
    provider: cred.provider,
    label: cred.label,
    source: cred.source,
    billingClass: cred.billingClass,
    enabled: cred.enabled,
    last4: cred.last4,
    status: a.reason === null ? "available" : STATUS[a.reason],
    until: a.until === null ? null : new Date(a.until).toISOString(),
    detail: a.detail,
    vaultKeyId: cred.vaultKeyId,
    apiKeyEnv: cred.apiKeyEnv,
  }));
}

/** A provider a key can be added for: built-in, custom (`providers:`), or `paid.providers`. */
export function keyProvider(sy: Switchyard, id: string | undefined): ResolvedProvider {
  const known = [...sy.providers.providers().keys()].sort();
  if (!id) throw new SwitchyardError("usage", `name a provider: ${known.join(", ")}`);
  const p = sy.providers.provider(id);
  if (!p) throw new SwitchyardError("usage", `unknown provider ${id}: choose one of ${known.join(", ")}, or add a custom OpenAI-compatible provider under providers.${id} with base_url in the config`);
  if (p.noKey) throw new SwitchyardError("usage", `${id} is configured with no_key: it takes no keys`);
  return p;
}

export interface AddKeyFlags {
  label?: string | undefined;
  billing?: string | undefined;
  balance?: string | undefined;
  cap?: string | undefined;
  rpm?: string | undefined;
  rpd?: string | undefined;
  tpm?: string | undefined;
  tpd?: string | undefined;
  "quota-group"?: string | undefined;
  "account-id"?: string | undefined;
}

const UsdFlag = z.coerce.number().positive();
/** The flag (or input) behind each vault field, for validation messages. */
const FLAG_OF: Record<string, string> = { secret: "the secret", label: "--label", quotaGroup: "--quota-group", accountId: "--account-id", prepaidBalanceUsd: "--balance", monthlyCapUsd: "--cap", provider: "provider" };

function usdFlag(name: string, value: string | undefined, allowZero = false): number | null {
  if (value === undefined) return null;
  const r = (allowZero ? z.coerce.number().min(0) : UsdFlag).safeParse(value);
  if (!r.success) throw new SwitchyardError("usage", `--${name} must be a number of US dollars${allowZero ? " >= 0" : " > 0"}, got ${JSON.stringify(value)}`);
  return r.data;
}

/**
 * Validate `keys add` flags into a vault entry. The billing class is required: whether a key is
 * free or paid decides which routing policy applies, so it is never guessed.
 */
export function newKeyInput(provider: ResolvedProvider, secret: string, f: AddKeyFlags) {
  const billing = BillingClassSchema.safeParse(f.billing);
  if (!billing.success) throw new SwitchyardError("usage", `--billing is required: ${BillingClassSchema.options.join(", ")} (free_tier: the key never costs money; the others are paid and follow paid.* policy and budgets)`);
  const accountId = f["account-id"] ?? null;
  if (provider.urlParams.includes("account_id") && !accountId && !provider.accountId) throw new SwitchyardError("usage", `${provider.id} keys need --account-id (or providers.${provider.id}.account_id in the config)`);
  const input = {
    provider: provider.id,
    secret,
    label: f.label ?? "",
    billingClass: billing.data,
    prepaidBalanceUsd: usdFlag("balance", f.balance, true),
    monthlyCapUsd: usdFlag("cap", f.cap),
    accountId,
    quotaGroup: f["quota-group"] ?? null,
    rpm: countFlag("rpm", f.rpm, 1) ?? null,
    rpd: countFlag("rpd", f.rpd, 1) ?? null,
    tpm: countFlag("tpm", f.tpm, 1) ?? null,
    tpd: countFlag("tpd", f.tpd, 1) ?? null,
  };
  const r = NewKeySchema.safeParse(input);
  if (!r.success) throw new SwitchyardError("usage", r.error.issues.map((i) => `${FLAG_OF[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`).join("; "));
  return r.data;
}

/** Store a new key in the vault (encrypted) after validating the provider and flags. */
export function addKey(sy: Switchyard, providerId: string | undefined, secret: string, f: AddKeyFlags): PaidKey {
  const provider = keyProvider(sy, providerId);
  return sy.vault.add(newKeyInput(provider, secret, f));
}

/** What `keys test` found for one key. */
export interface KeyTest {
  ref: string | null;
  provider: string;
  label: string;
  last4: string;
  ok: boolean;
  /** Model ids the key's listing returned (chat models only where the provider says). */
  models: string[];
  /** Models the listing returned that SwitchYard cannot use (not chat models), with why. */
  excluded: Array<{ model: string; reason: string }>;
  pages: number;
  /** Why the key was not tested (disabled, env var unset, ...). */
  skipped: string | null;
  error: { kind: ProviderErrorKind | "error"; message: string } | null;
  /** The key had been recorded as invalid and this listing worked, so the mark was cleared. */
  cleared: boolean;
}

/** A key test's result in `keys test` terms (models as sorted ids). */
function keyTest(base: KeyTest, o: KeyTestOutcome): KeyTest {
  if (o.skipped) return { ...base, skipped: o.skipped };
  if (!o.listing) return { ...base, error: o.error };
  return { ...base, ok: true, models: o.listing.models.map((m) => m.id).sort(), excluded: o.listing.excluded, pages: o.listing.pages, cleared: o.cleared };
}

const testOpts = (sy: Switchyard) => ({ timeoutMs: keyTestTimeoutMs(sy.cfg.providers.request_timeout_seconds) });

/** The credentials `keys test <target>` covers: every key, one provider's, a vault id, or a ref. */
export function testTargets(sy: Switchyard, target: string | undefined): ProviderCredential[] {
  const creds = sy.providers.credentials();
  if (target === undefined) return creds.list();
  if (sy.providers.provider(target)) return creds.list(target);
  const ref = /^\d+$/.test(target) ? `vault:${target}` : target;
  const one = creds.get(ref);
  if (!one) throw new SwitchyardError("not_found", `no provider or key ${target}: give a provider id, a vault key id, or a ref from switchyard keys list`);
  return [one];
}

/**
 * List the models each key can use (`keys test`), through the shared key test
 * (`testKeyListing`): a key the provider rejects (401/403) or reports out of credits (402) is
 * recorded as a failed request would record it; a key recorded as invalid whose listing now
 * works is cleared. Provider messages arrive with the secret masked. Nothing is written to the
 * catalog: `models scan` does that.
 */
export async function testKeys(sy: Switchyard, target?: string): Promise<KeyTest[]> {
  const results: KeyTest[] = [];
  for (const cred of testTargets(sy, target)) {
    const base: KeyTest = { ref: cred.ref, provider: cred.provider, label: cred.label, last4: cred.last4, ok: false, models: [], excluded: [], pages: 0, skipped: null, error: null, cleared: false };
    results.push(keyTest(base, await testKeyListing(sy.providers, { credential: cred }, testOpts(sy))));
  }
  return results;
}

/** List models with a secret that is not stored yet (`keys add --test`). Nothing is recorded. */
export async function testSecret(sy: Switchyard, provider: ResolvedProvider, secret: string, accountId: string | null): Promise<KeyTest> {
  const base: KeyTest = { ref: null, provider: provider.id, label: "new key", last4: secret.slice(-4), ok: false, models: [], excluded: [], pages: 0, skipped: null, error: null, cleared: false };
  return keyTest(base, await testKeyListing(sy.providers, { provider, secret, accountId }, testOpts(sy)));
}

/** One key's test as terminal text: a header line, then the models (up to `max`). */
export function keyTestText(t: KeyTest, max = 40): string {
  const who = `${t.provider} ${t.label} (${t.ref ?? "not stored"}${t.last4 ? `, ...${t.last4}` : ""})`;
  if (t.skipped) return `${who}: not tested: ${t.skipped}`;
  if (!t.ok) return `${who}: FAILED ${t.error!.kind}: ${t.error!.message}`;
  const lines = [`${who}: ok, ${t.models.length} model(s)${t.excluded.length ? ` (${t.excluded.length} more listed but not usable for chat)` : ""}${t.cleared ? "; the invalid mark was cleared" : ""}`];
  for (const m of t.models.slice(0, max)) lines.push(`  ${m}`);
  if (t.models.length > max) lines.push(`  ... ${t.models.length - max} more (--json lists all)`);
  return lines.join("\n");
}

function statusText(r: KeyRow): string {
  if (r.status === "available") return "ok";
  const until = r.until ? ` until ${stamp(Date.parse(r.until))}` : "";
  const names: Record<KeyStatus, string> = { available: "ok", unusable: "unusable", invalid: "INVALID", out_of_credits: "out of credits", cooling: "cooling down", exhausted: "rate limit reached", free_quota: "free daily quota used", limit: "configured limit reached" };
  return `${names[r.status]}${until}`;
}

/** The secret for `keys add`: SWITCHYARD_NEW_KEY, else a hidden prompt on an interactive terminal. */
async function newSecret(provider: string): Promise<string> {
  const env = process.env[NEW_KEY_ENV];
  if (env) return env.trim();
  if (!process.stdin.isTTY) throw new SwitchyardError("usage", `set ${NEW_KEY_ENV} to the secret, or run keys add in an interactive terminal to type it (the secret is never taken from the command line)`);
  const secret = (await readHiddenLine(`${provider} API key (input hidden): `)).trim();
  if (!secret) throw new SwitchyardError("usage", "no key entered");
  return secret;
}

export interface KeysFlags extends AddKeyFlags {
  test?: boolean | undefined;
}

const USAGE = "usage: keys list [provider] | add <provider> --billing <class> [options] | test [provider|id|ref] | enable|disable|remove <id> | spend";

/** `switchyard keys ...`. Returns the exit code. */
export async function keysCommand(sy: Switchyard, args: string[], flags: KeysFlags, json: boolean): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const rows = keyRows(sy, args[1]);
    out(json ? rows : table(rows.map((r) => ({ ref: r.ref, provider: r.provider, label: r.label, billing: r.billingClass, key: r.last4 ? `...${r.last4}` : "", status: statusText(r), detail: r.detail ?? "" }))), json);
    return 0;
  }
  if (sub === "add") {
    const provider = keyProvider(sy, args[1]);
    const secret = await newSecret(provider.id);
    const input = newKeyInput(provider, secret, flags);
    if (flags.test) {
      const t = await testSecret(sy, provider, secret, input.accountId);
      if (!t.ok) {
        out(json ? { added: null, test: t } : `${keyTestText(t)}\nthe key was not stored`, json);
        return 1;
      }
      if (!json) out(keyTestText(t, 10), false);
      const k = sy.vault.add(input);
      out(json ? { added: { ...k, ref: `vault:${k.id}` }, test: t } : `added key vault:${k.id} for ${provider.id} (...${k.last4}); run switchyard models scan to add its models`, json);
      return 0;
    }
    const k = sy.vault.add(input);
    out(json ? { added: { ...k, ref: `vault:${k.id}` }, test: null } : `added key vault:${k.id} for ${provider.id} (...${k.last4}), ${k.billingClass}\nnext: switchyard keys test vault:${k.id} (lists the models it can use), then switchyard models scan`, json);
    return 0;
  }
  if (sub === "test") {
    const results = await testKeys(sy, args[1]);
    out(json ? results : results.length ? results.map((t) => keyTestText(t)).join("\n") : "no keys: add one with switchyard keys add <provider> --billing <class>", json);
    return results.some((t) => t.error) ? 1 : 0;
  }
  if (sub === "enable" || sub === "disable" || sub === "remove") {
    const id = vaultId(sy, args[1], sub);
    if (sub === "remove") {
      sy.vault.remove(id);
      sy.providers.keys.forget(`vault:${id}`);
      out(json ? { ref: `vault:${id}`, removed: true } : `key vault:${id} removed (a key with recorded spend keeps its row, without the secret)`, json);
      return 0;
    }
    sy.vault.update(id, { enabled: sub === "enable" });
    // Re-enabling is the user saying the key is fixed: clear any invalid or cooling state.
    if (sub === "enable") sy.providers.keys.clear(`vault:${id}`);
    out(json ? { ref: `vault:${id}`, enabled: sub === "enable" } : `key vault:${id} ${sub}d`, json);
    return 0;
  }
  if (sub === "spend") {
    out(sy.spend.summary(), true);
    return 0;
  }
  throw new SwitchyardError("usage", USAGE);
}

/** A vault key id from `<id>` or `vault:<id>`; config keys are changed in the config file. */
function vaultId(sy: Switchyard, arg: string | undefined, sub: string): number {
  if (!arg) throw new SwitchyardError("usage", `usage: switchyard keys ${sub} <id>  (a vault key id or vault:<id> from switchyard keys list)`);
  if (arg.startsWith("config:") || arg.startsWith("none:")) throw new SwitchyardError("usage", `${arg} is declared in ${sy.cfg.configPath}: change it there`);
  const m = /^(?:vault:)?(\d+)$/.exec(arg);
  if (!m) throw new SwitchyardError("usage", `not a vault key id: ${arg}`);
  const id = Number(m[1]);
  if (!sy.vault.get(id)) throw new SwitchyardError("not_found", `unknown key vault:${id}`);
  return id;
}
