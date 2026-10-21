"use client";

import { useState, type ReactNode } from "react";
import { Check, FlaskConical, KeyRound, Pencil, Plus, Radar, RefreshCw, Server, Trash2, X } from "lucide-react";
import type { insights } from "switchyard-router";
import { ActionStatus, callApi, useAction } from "./actions";
import { Badge, buttonClass, cx, HelpTip, type Tone } from "../ui";
import { ago, dateTime, num } from "@/lib/format";
import { BILLING_LABEL, usd } from "@/lib/billing";

export type KeyView = insights.ProviderKeyView;
export type KeyTestResult = insights.KeyTestResult;

/** What the add form needs to know about each provider. */
export interface ProviderOption {
  id: string;
  displayName: string;
  kind: insights.ProviderKind;
  needsAccountId: boolean;
  noKey: boolean;
  accountId: string | null;
}

const CUSTOM = "__custom";

/**
 * Built-in local servers (mirrors the registry's `local` providers in
 * packages/router/src/providers/registry.ts): set up by writing `providers.<id>` to the config
 * with an optional base URL; they take no key (Ollama never; LM Studio and llama.cpp only when
 * their own authentication is turned on).
 */
const LOCAL_SERVERS: Record<string, { defaultUrl: string | null; keys: "none" | "optional"; hint: string }> = {
  ollama: { defaultUrl: "http://127.0.0.1:11434/v1", keys: "none", hint: "Empty uses OLLAMA_HOST if set, else 127.0.0.1:11434." },
  lmstudio: { defaultUrl: "http://localhost:1234/v1", keys: "optional", hint: "Start the server in LM Studio's Developer tab. Empty uses localhost:1234." },
  llamacpp: { defaultUrl: null, keys: "optional", hint: "Required: llama-server's port differs between releases (9931 or 8080)." },
};
const LIMITS = ["rpm", "rpd", "tpm", "tpd"] as const;
const LIMIT_LABEL: Record<(typeof LIMITS)[number], string> = { rpm: "Requests / minute", rpd: "Requests / day", tpm: "Tokens / minute", tpd: "Tokens / day" };

/** "" -> null, a number -> that number, anything else -> "bad". */
const toNum = (s: string): number | null | "bad" => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : "bad";
};
const toDate = (s: string): number | null => (s ? new Date(`${s}T23:59:59`).getTime() : null);
const fromDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function Field({ label, help, children, className }: { label: ReactNode; help?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block text-sm text-ink-2", className)}>
      <span className="inline-flex items-center gap-1">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-[11px] text-ink-3">{help}</span> : null}
    </label>
  );
}

/** Limits and paid fields shared by the add and edit forms (all optional). */
interface Extras {
  quotaGroup: string;
  limits: Record<(typeof LIMITS)[number], string>;
  cap: string;
  balance: string;
  expires: string;
}
const emptyExtras = (): Extras => ({ quotaGroup: "", limits: { rpm: "", rpd: "", tpm: "", tpd: "" }, cap: "", balance: "", expires: "" });

function extrasPayload(e: Extras, paid: boolean): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = { quotaGroup: orNull(e.quotaGroup) };
  for (const l of LIMITS) {
    const n = toNum(e.limits[l]);
    if (n === "bad" || (n !== null && (!Number.isInteger(n) || n <= 0))) return { ok: false, error: `${LIMIT_LABEL[l]} must be a whole number above 0, or empty.` };
    out[l] = n;
  }
  const cap = paid ? toNum(e.cap) : null;
  const balance = paid ? toNum(e.balance) : null;
  if (cap === "bad" || balance === "bad") return { ok: false, error: "Cap and balance must be numbers (or empty)." };
  out.monthlyCapUsd = cap;
  out.prepaidBalanceUsd = balance;
  out.expiresAt = toDate(e.expires);
  return { ok: true, value: out };
}

function ExtrasFields({ value, onChange, billing }: { value: Extras; onChange: (e: Extras) => void; billing: string }) {
  const paid = billing !== "" && billing !== "free_tier";
  return (
    <details className="rounded-lg border border-line px-3 py-2" open={paid || Object.values(value.limits).some(Boolean) || Boolean(value.quotaGroup)}>
      <summary className="cursor-pointer text-sm font-medium text-ink-2">Limits{paid ? ", cap, and balance" : ""} (optional)</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {LIMITS.map((l) => (
          <Field key={l} label={LIMIT_LABEL[l]}>
            <input value={value.limits[l]} onChange={(e) => onChange({ ...value, limits: { ...value.limits, [l]: e.target.value } })} inputMode="numeric" className="field tabular mt-1" placeholder="from headers" />
          </Field>
        ))}
        <Field label={<>Quota group <HelpTip term="quotaScope" /></>} help="Keys sharing one provider account or project share one allowance.">
          <input value={value.quotaGroup} onChange={(e) => onChange({ ...value, quotaGroup: e.target.value })} className="field mt-1" placeholder="none" maxLength={64} />
        </Field>
        {paid ? (
          <>
            <Field label="Monthly cap (USD)">
              <input value={value.cap} onChange={(e) => onChange({ ...value, cap: e.target.value })} inputMode="decimal" className="field tabular mt-1" placeholder="no cap" />
            </Field>
            <Field label="Prepaid balance (USD)">
              <input value={value.balance} onChange={(e) => onChange({ ...value, balance: e.target.value })} inputMode="decimal" className="field tabular mt-1" placeholder="not tracked" />
            </Field>
          </>
        ) : null}
        <Field label="Expires">
          <input type="date" value={value.expires} onChange={(e) => onChange({ ...value, expires: e.target.value })} className="field mt-1" />
        </Field>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Limits are enforced by SwitchYard as sliding windows on top of what the provider&apos;s rate-limit headers report.</p>
    </details>
  );
}

// ---------- add a key ----------

export function AddKeyForm({ providers, billingClasses }: { providers: ProviderOption[]; billingClasses: readonly string[] }) {
  const [provider, setProvider] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [billing, setBilling] = useState("");
  const [accountId, setAccountId] = useState("");
  const [extras, setExtras] = useState<Extras>(emptyExtras());
  const [test, setTest] = useState<KeyTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const { run, busy, error, errors, message, setError, setMessage } = useAction();
  const p = providers.find((x) => x.id === provider) ?? null;
  const local = p && p.kind === "builtin" ? (LOCAL_SERVERS[p.id] ?? null) : null;
  const takesKeys = providers.filter((x) => !x.noKey && !(x.kind === "builtin" && LOCAL_SERVERS[x.id]));
  const groups: Array<[string, ProviderOption[]]> = [
    ["Local servers (no key)", providers.filter((x) => x.kind === "builtin" && LOCAL_SERVERS[x.id])],
    ["Built-in providers", takesKeys.filter((x) => x.kind === "builtin")],
    ["Custom providers (from the config)", takesKeys.filter((x) => x.kind === "custom")],
    ["Paid providers (Settings)", takesKeys.filter((x) => x.kind === "paid")],
  ];
  const needsAccount = Boolean(p?.needsAccountId && !p.accountId);

  const runTest = async () => {
    setTest(null);
    setError(null);
    setMessage(null);
    setTesting(true);
    const r = await callApi("/api/keys/test", "POST", { provider, secret, accountId: orNull(accountId), billingClass: billing || "free_tier" });
    setTesting(false);
    if (!r.ok) setError(r.error ?? "The test could not run");
    else setTest(r.result as KeyTestResult);
  };

  const providerSelect = (
    <Field label="Provider">
      <select
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value);
          setTest(null);
        }}
        className="field mt-1"
        required
      >
        <option value="" disabled>
          Choose…
        </option>
        {groups.map(([g, list]) =>
          list.length ? (
            <optgroup key={g} label={g}>
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.displayName === x.id ? x.id : `${x.displayName} (${x.id})`}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
        <option value={CUSTOM}>Add a custom provider…</option>
      </select>
    </Field>
  );

  if (p && local) return <LocalServerForm key={p.id} provider={p} local={local} select={providerSelect} />;

  return (
    <div className="space-y-4">
      <form
        className="space-y-3"
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          const x = extrasPayload(extras, billing !== "free_tier");
          if (!x.ok) return setError(x.error);
          const r = await run("/api/keys", "POST", { provider, label, secret, billingClass: billing, accountId: orNull(accountId), ...x.value }, { success: "Key stored in the encrypted vault. Only its last four characters are ever shown. Use Find models on its provider to list what it can use." });
          // The secret is cleared whether or not the request succeeded; it is never kept in the page.
          setSecret("");
          setTest(null);
          if (r.ok) {
            setLabel("");
            setAccountId("");
            setExtras(emptyExtras());
          }
        }}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {providerSelect}
          {provider === CUSTOM ? null : (
            <>
              <Field label="API key">
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="field mt-1 font-mono" placeholder="paste the key" autoComplete="new-password" required minLength={8} aria-describedby="key-storage-note" />
              </Field>
              <Field label={<>Billing class <HelpTip term="billingClass" /></>}>
                <select value={billing} onChange={(e) => setBilling(e.target.value)} className="field mt-1" required>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {billingClasses.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_LABEL[b] ?? b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Label (optional)">
                <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-1" placeholder="e.g. personal account" maxLength={80} />
              </Field>
              {p?.needsAccountId ? (
                <Field label="Account id" help={p.accountId ? `Optional: the provider's account id (${p.accountId}) is used when empty.` : "Required: it goes in the request URL."}>
                  <input value={accountId} onChange={(e) => setAccountId(e.target.value)} className="field mt-1 font-mono" placeholder={p.accountId ?? "account id"} required={needsAccount} maxLength={128} />
                </Field>
              ) : null}
            </>
          )}
        </div>
        {provider === CUSTOM ? null : (
          <>
            <ExtrasFields value={extras} onChange={setExtras} billing={billing} />
            <p id="key-storage-note" className="text-xs text-ink-3">
              The key is encrypted at rest (AES-256-GCM) in SwitchYard&apos;s vault and sent only to this provider. It is never shown again; the panel shows its last four characters. A free-tier key on a model the provider lists at $0 is free; any other key follows the paid policy and budgets in Settings.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonClass("secondary")} disabled={testing || busy || !p || secret.trim().length < 8 || (needsAccount && !accountId.trim())} onClick={() => void runTest()}>
                {testing ? <RefreshCw size={14} className="animate-spin" aria-hidden /> : <FlaskConical size={14} aria-hidden />} Test key
              </button>
              <button type="submit" className={buttonClass("primary")} disabled={busy || !p || !billing || secret.trim().length < 8}>
                <Plus size={14} aria-hidden /> Add key
              </button>
              <ActionStatus error={error} message={message} errors={errors} />
            </div>
          </>
        )}
      </form>
      {provider === CUSTOM ? <CustomProviderForm onAdded={(id) => setProvider(id)} /> : null}
      {test ? <TestResultView result={test} /> : null}
    </div>
  );
}

/**
 * Set up a built-in local server: write `providers.<id>` (enabled, with the base URL when one is
 * given) through the config API, and optionally store a token for a server whose authentication
 * is turned on. No key is needed otherwise; models are found with Find models on its card.
 */
function LocalServerForm({ provider, local, select }: { provider: ProviderOption; local: (typeof LOCAL_SERVERS)[string]; select: ReactNode }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const { run, busy, error, errors, message, setError } = useAction();
  const required = local.defaultUrl === null;
  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const url = baseUrl.trim().replace(/\/+$/, "");
        if (url && !/^https?:\/\//i.test(url)) return setError("The base URL must start with http:// or https://");
        const patch = [
          { path: ["providers", provider.id, "enabled"], value: true },
          { path: ["providers", provider.id, "base_url"], value: url || null },
        ];
        const r = await run("/api/config", "POST", { patch }, { success: `${provider.displayName} is set up${url ? ` at ${url}` : ""}. It takes no key: use Find models on its card.` });
        if (!r.ok || !token.trim()) return;
        const k = await run("/api/keys", "POST", { provider: provider.id, label: "server token", secret: token.trim(), billingClass: "free_tier" }, { success: `${provider.displayName} is set up, with its token stored in the encrypted vault. Use Find models on its card.` });
        setToken("");
        if (!k.ok) setError(`The server was set up, but its token was not stored: ${k.error ?? "unknown error"}`);
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {select}
        <Field label={required ? "Base URL" : "Base URL (optional)"} help={local.hint}>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="field mt-1 font-mono" placeholder={local.defaultUrl ?? "http://127.0.0.1:8080/v1"} required={required} type="url" />
        </Field>
        {local.keys === "optional" ? (
          <Field label="Token (only if the server requires one)" help="Stored encrypted, like any key. Leave empty for a server without authentication.">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="field mt-1 font-mono" placeholder="none" autoComplete="new-password" />
          </Field>
        ) : (
          <div className="self-end pb-2 text-sm text-ink-2">
            <Badge tone="good">No key needed</Badge>
          </div>
        )}
      </div>
      <p className="text-xs text-ink-3">
        A local server runs on your machine or network and costs nothing per request. SwitchYard writes <code className="font-mono">providers.{provider.id}</code> to the config file and reads the server&apos;s own model list, including each model&apos;s context and tool support where the server reports them.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass("primary")} disabled={busy || (required && !baseUrl.trim())}>
          <Server size={14} aria-hidden /> Set up {provider.displayName}
        </button>
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </form>
  );
}

function CustomProviderForm({ onAdded }: { onAdded: (id: string) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai_compatible");
  const [noKey, setNoKey] = useState(false);
  const [modelsPath, setModelsPath] = useState("");
  const { run, busy, error, errors, message } = useAction();
  return (
    <form
      className="space-y-3 rounded-lg border border-line bg-surface-2/50 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(
          "/api/keys/providers",
          "POST",
          { id, baseUrl, api, noKey, ...(name.trim() ? { displayName: name.trim() } : {}), ...(modelsPath.trim() ? { modelsPath: modelsPath.trim() } : {}) },
          { success: noKey ? `Added ${id} to the config. It takes no key: use Find models on its card.` : `Added ${id} to the config. Now paste its key.` },
        );
        if (r.ok && !noKey) onAdded(id);
      }}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <Server size={14} aria-hidden /> Custom provider
      </div>
      <p className="text-xs text-ink-3">Any OpenAI-compatible server: a local vLLM, LocalAI, Jan, KoboldCpp, or SGLang, or a hosted provider that is not built in. Ollama, LM Studio, and llama.cpp are built in: pick them under Local servers. It is written under <code className="font-mono">providers</code> in the config file.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Id" help="Lowercase letters, digits, dashes. Models appear as <id>/<model>.">
          <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} className="field mt-1 font-mono" placeholder="e.g. vllm" required pattern="[a-z0-9][a-z0-9-]{0,63}" />
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} className="field mt-1" placeholder="e.g. vLLM on the GPU box" maxLength={80} />
        </Field>
        <Field label="Base URL" help="The URL the API paths go under, usually ending in /v1.">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="field mt-1 font-mono" placeholder="http://localhost:8000/v1" required type="url" />
        </Field>
        <Field label="API style">
          <select value={api} onChange={(e) => setApi(e.target.value)} className="field mt-1">
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </Field>
        <Field label="Model list path (optional)">
          <input value={modelsPath} onChange={(e) => setModelsPath(e.target.value)} className="field mt-1 font-mono" placeholder="/models" />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-2">
          <input type="checkbox" checked={noKey} onChange={(e) => setNoKey(e.target.checked)} /> Takes no key (local server)
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass("primary")} disabled={busy || !id || !baseUrl}>
          <Plus size={14} aria-hidden /> Add provider
        </button>
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </form>
  );
}

// ---------- test results ----------

const ERROR_LABEL: Record<string, string> = {
  auth_invalid: "The provider rejected the key",
  out_of_credits: "The account is out of credits",
  rate_limited: "The provider is rate limiting this key",
  timeout: "The provider did not answer in time",
  transport: "The provider could not be reached",
  server: "The provider returned an error",
  error: "The test could not run",
};

export function TestResultView({ result, onClose }: { result: KeyTestResult; onClose?: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? result.models : result.models.slice(0, 24);
  return (
    <div role="status" className={cx("rounded-lg border px-3 py-2 text-sm", result.ok ? "border-good/30 bg-good-soft" : "border-bad/30 bg-bad-soft")}>
      <div className="flex items-start justify-between gap-2">
        <div className={cx("font-medium", result.ok ? "text-good-ink" : "text-bad-ink")}>
          {result.ok
            ? result.models.length
              ? `The key works: ${result.models.length} model${result.models.length === 1 ? "" : "s"} it can use on ${result.provider}`
              : `The key works, but ${result.provider} lists no model it can use`
            : `${ERROR_LABEL[result.error?.kind ?? "error"] ?? "The test failed"}`}
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} className={buttonClass("ghost", true)} aria-label="Close test result">
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      {!result.ok && result.error ? <p className="mt-1 break-words text-xs text-bad-ink">{result.error.message}</p> : null}
      {result.models.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Models this key can use">
          {shown.map((m) => (
            <li key={m.id}>
              <Badge tone={m.free ? "good" : "neutral"} title={`${m.free ? "Free" : "Paid"}: ${m.freeReason}${m.contextLimitTokens ? ` · ${num(m.contextLimitTokens)} context` : ""}`}>
                <span className="font-mono">{m.id}</span>
              </Badge>
            </li>
          ))}
          {result.models.length > shown.length ? (
            <li>
              <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setAll(true)}>
                and {result.models.length - shown.length} more
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {result.ok ? (
        <p className="mt-2 text-[11px] text-ink-3">
          Green: free with this key. {result.excluded.length ? `${result.excluded.length} listed model${result.excluded.length === 1 ? " was" : "s were"} left out (not chat models, or priced models a free key cannot reach). ` : ""}
          Testing reads the provider&apos;s model list only; it sends no chat request.
        </p>
      ) : null}
    </div>
  );
}

// ---------- key rows ----------

const STATUS: Record<KeyView["status"], { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "good" },
  cooling: { label: "Cooling down", tone: "warn" },
  limited: { label: "At a limit", tone: "warn" },
  invalid: { label: "Invalid key", tone: "bad" },
  out_of_credits: { label: "Out of credits", tone: "bad" },
  disabled: { label: "Disabled", tone: "neutral" },
  removed: { label: "Removed", tone: "neutral" },
  unusable: { label: "Not usable", tone: "bad" },
};

export function KeyStatus({ k, now }: { k: KeyView; now: number }) {
  const s = STATUS[k.status];
  const back = k.until !== null ? (k.status === "out_of_credits" ? ` · recheck ${ago(k.until, now)}` : ` · back ${ago(k.until, now)}`) : "";
  return (
    <div className="space-y-0.5">
      <Badge tone={s.tone} {...(k.until !== null ? { title: `until ${dateTime(k.until)}` } : {})}>
        {s.label}
        {back}
      </Badge>
      {k.statusDetail ? <div className="break-words text-[11px] text-ink-3">{k.statusDetail}</div> : null}
      {/* An error the key has since recovered from is history: shown only on hover, never beside "Healthy". */}
      {k.errorCurrent ? (
        k.lastError && k.lastError !== k.statusDetail ? (
          <div className="break-words text-[11px] text-bad-ink" title={k.lastErrorAt ? dateTime(k.lastErrorAt) : undefined}>
            Last error {ago(k.lastErrorAt, now)}: {k.lastError}
          </div>
        ) : null
      ) : k.lastError && k.lastErrorAt ? (
        <div className="text-[11px] text-ink-3" title={`${k.lastError} (${dateTime(k.lastErrorAt)})`}>
          Recovered since its last error {ago(k.lastErrorAt, now)}
        </div>
      ) : null}
    </div>
  );
}

function limitsText(k: KeyView): string | null {
  const parts = LIMITS.filter((l) => k.limits[l] !== null).map((l) => `${num(k.limits[l]!)} ${l}`);
  if (k.quotaGroup) parts.push(`group ${k.quotaGroup}`);
  return parts.length ? parts.join(" · ") : null;
}

export function KeyRow({ k, now }: { k: KeyView; now: number }) {
  const { run, busy, error, errors, message, setError } = useAction();
  const [editing, setEditing] = useState(false);
  const [arming, setArming] = useState(false);
  const [test, setTest] = useState<KeyTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const paid = k.billingClass !== "free_tier";
  const lim = limitsText(k);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setError(null);
    const r = await callApi("/api/keys/test", "POST", { ref: k.ref });
    setTesting(false);
    if (!r.ok) setError(r.error ?? "The test could not run");
    else setTest(r.result as KeyTestResult);
  };

  return (
    <li className={cx("px-4 py-3", (k.status === "disabled" || k.status === "removed") && "opacity-75")}>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,1.3fr)_minmax(9rem,1fr)_minmax(10rem,1.2fr)_auto] md:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound size={14} className="text-ink-3" aria-hidden />
            <span className="font-medium text-ink">{k.label}</span>
            {k.last4 ? <span className="font-mono text-xs text-ink-2">••••{k.last4}</span> : null}
          </div>
          <div className="mt-0.5 break-words text-[11px] text-ink-3">
            {k.source === "vault" ? <>Vault{k.createdAt ? ` · added ${dateTime(k.createdAt)}` : ""}</> : <>Config: <code className="font-mono">{k.origin}</code> · {k.secretSource}</>}
            {k.accountId ? <> · account <code className="font-mono">{k.accountId}</code></> : null}
            {k.expiresAt ? <span className={k.expiresAt < now ? "text-bad-ink" : undefined}> · {k.expiresAt < now ? "expired" : "expires"} {new Date(k.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span> : null}
          </div>
        </div>
        <div className="min-w-0 space-y-1 text-xs">
          <Badge tone={k.billingClass === "free_tier" ? "good" : k.billingClass === "trial" ? "accent" : "neutral"}>{BILLING_LABEL[k.billingClass] ?? k.billingClass}</Badge>
          <div className="text-ink-3">{lim ?? "limits from headers"}</div>
          {paid ? (
            <div className="tabular text-ink-2">
              {usd(k.spent30dUsd)} in 30 days
              {k.monthlyCapUsd !== null ? <> · {usd(k.remainingCapUsd)} of {usd(k.monthlyCapUsd)} cap left</> : null}
              {k.prepaidBalanceUsd !== null ? <> · balance {usd(k.remainingBalanceUsd)}</> : null}
            </div>
          ) : null}
        </div>
        <KeyStatus k={k} now={now} />
        <div className="flex flex-wrap items-center gap-1 md:justify-end">
          {k.status !== "removed" ? (
            <button type="button" className={buttonClass("ghost", true)} disabled={testing} onClick={() => void runTest()} title="List the models this key can use">
              {testing ? <RefreshCw size={13} className="animate-spin" aria-hidden /> : <FlaskConical size={13} aria-hidden />} Test
            </button>
          ) : null}
          {k.editable ? (
            <>
              <label className="mx-1 inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                <input type="checkbox" role="switch" className="sr-only" checked={k.enabled} disabled={busy} onChange={(e) => run(`/api/keys/${k.vaultKeyId}`, "PATCH", { enabled: e.target.checked })} />
                <span className={cx("relative h-5 w-9 rounded-full transition-colors", k.enabled ? "bg-accent" : "bg-surface-3")} aria-hidden>
                  <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", k.enabled ? "left-4.5" : "left-0.5")} />
                </span>
                {k.enabled ? "On" : "Off"}
              </label>
              <button type="button" className={buttonClass("ghost", true)} onClick={() => setEditing((e) => !e)} aria-label="Edit key" aria-expanded={editing}>
                <Pencil size={13} aria-hidden />
              </button>
              <button
                type="button"
                disabled={busy}
                className={buttonClass(arming ? "danger" : "ghost", true)}
                onClick={async () => {
                  if (!arming) {
                    setArming(true);
                    setTimeout(() => setArming(false), 4000);
                    return;
                  }
                  setArming(false);
                  await run(`/api/keys/${k.vaultKeyId}`, "DELETE", undefined, { success: "Key removed" });
                }}
                aria-label="Remove key"
              >
                <Trash2 size={13} aria-hidden /> {arming ? "Remove permanently?" : ""}
              </button>
            </>
          ) : k.status === "removed" ? (
            <Badge title="Removed keys with paid spend stay listed so spend history stays complete">kept for history</Badge>
          ) : (
            <span className="text-[11px] text-ink-3" title={`Edit ${k.origin} in the config file`}>
              read-only (config)
            </span>
          )}
        </div>
      </div>
      {error || message ? (
        <div className="mt-2">
          <ActionStatus error={error} message={message} errors={errors} />
        </div>
      ) : null}
      {test ? (
        <div className="mt-2">
          <TestResultView result={test} onClose={() => setTest(null)} />
        </div>
      ) : null}
      {editing ? <EditKeyForm k={k} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}

function EditKeyForm({ k, onDone }: { k: KeyView; onDone: () => void }) {
  const { run, busy, error, errors, setError } = useAction();
  const [label, setLabel] = useState(k.label);
  const [billing, setBilling] = useState<string>(k.billingClass);
  const [accountId, setAccountId] = useState(k.accountId ?? "");
  const [secret, setSecret] = useState("");
  const [extras, setExtras] = useState<Extras>({
    quotaGroup: k.quotaGroup ?? "",
    limits: { rpm: k.limits.rpm?.toString() ?? "", rpd: k.limits.rpd?.toString() ?? "", tpm: k.limits.tpm?.toString() ?? "", tpd: k.limits.tpd?.toString() ?? "" },
    cap: k.monthlyCapUsd?.toString() ?? "",
    balance: k.prepaidBalanceUsd?.toString() ?? "",
    expires: fromDate(k.expiresAt),
  });

  const save = async () => {
    const x = extrasPayload(extras, billing !== "free_tier");
    if (!x.ok) return setError(x.error);
    const next: Record<string, unknown> = { label: label.trim(), billingClass: billing, accountId: orNull(accountId), ...x.value };
    const before: Record<string, unknown> = { label: k.label, billingClass: k.billingClass, accountId: k.accountId, quotaGroup: k.quotaGroup, ...k.limits, monthlyCapUsd: k.monthlyCapUsd, prepaidBalanceUsd: k.prepaidBalanceUsd, expiresAt: k.expiresAt ? toDate(fromDate(k.expiresAt)) : null };
    const patch = Object.fromEntries(Object.entries(next).filter(([key, v]) => v !== before[key]));
    if (secret.trim()) patch.secret = secret.trim();
    if (!Object.keys(patch).length) return onDone();
    const r = await run(`/api/keys/${k.vaultKeyId}`, "PATCH", patch, { success: "Saved" });
    setSecret("");
    if (r.ok) onDone();
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2/50 p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-1" maxLength={80} />
        </Field>
        <Field label="Billing class">
          <select value={billing} onChange={(e) => setBilling(e.target.value)} className="field mt-1">
            {Object.keys(BILLING_LABEL).map((b) => (
              <option key={b} value={b}>
                {BILLING_LABEL[b]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Account id (if the provider needs one)">
          <input value={accountId} onChange={(e) => setAccountId(e.target.value)} className="field mt-1 font-mono" placeholder="none" maxLength={128} />
        </Field>
        <Field label="Replace the key (optional)" help="Clears a recorded invalid or out-of-credits state.">
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="field mt-1 font-mono" placeholder="paste a new key" autoComplete="new-password" />
        </Field>
      </div>
      <ExtrasFields value={extras} onChange={setExtras} billing={billing} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("primary", true)} disabled={busy} onClick={() => void save()}>
          <Check size={13} aria-hidden /> Save
        </button>
        <button type="button" className={buttonClass("ghost", true)} onClick={onDone}>
          <X size={13} aria-hidden /> Cancel
        </button>
        <ActionStatus error={error} errors={errors} />
      </div>
    </div>
  );
}

// ---------- provider actions ----------

export function ProviderActions({ id, discoverable, removable }: { id: string; discoverable: boolean; removable: boolean }) {
  const { run, busy, error, message, setMessage } = useAction();
  const [arming, setArming] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {discoverable ? (
          <button
            type="button"
            className={buttonClass("secondary", true)}
            disabled={busy}
            onClick={async () => {
              const r = await run("/api/keys/scan", "POST", { provider: id });
              if (!r.ok) return;
              const s = r.scan as insights.ProviderScanResult;
              setMessage(s.status === "listed" ? `Listed ${s.kept} model${s.kept === 1 ? "" : "s"}${s.added.length ? ` (${s.added.length} new)` : ""}.` : `The model list failed: ${s.errors[0] ?? s.status}`);
            }}
            title="List and save this provider's models now"
          >
            {busy ? <RefreshCw size={13} className="animate-spin" aria-hidden /> : <Radar size={13} aria-hidden />} Find models
          </button>
        ) : null}
        {removable ? (
          <button
            type="button"
            disabled={busy}
            className={buttonClass(arming ? "danger" : "ghost", true)}
            onClick={async () => {
              if (!arming) {
                setArming(true);
                setTimeout(() => setArming(false), 4000);
                return;
              }
              setArming(false);
              await run(`/api/keys/providers/${id}`, "DELETE", undefined, { success: "Provider removed from the config" });
            }}
            aria-label="Remove custom provider"
          >
            <Trash2 size={13} aria-hidden /> {arming ? "Remove provider?" : ""}
          </button>
        ) : null}
      </div>
      <ActionStatus error={error} message={message} />
    </div>
  );
}
