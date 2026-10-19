"use client";

import { useState } from "react";
import { Check, KeyRound, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { Badge, buttonClass, cx, HelpTip } from "../ui";
import { dateTime } from "@/lib/format";
import { BILLING_LABEL, usd } from "@/lib/billing";

const BILLING_OPTIONS = ["paid_postpaid", "paid_credits", "trial", "free_tier"] as const;

/** The key shape the server sends: metadata only. There is no secret field to render. */
export interface PaidKeyView {
  id: number;
  provider: string;
  label: string;
  billingClass: string;
  enabled: boolean;
  last4: string;
  monthlyCapUsd: number | null;
  prepaidBalanceUsd: number | null;
  expiresAt: number | null;
  createdAt: number;
  spent30d: number | null;
  remainingBalanceUsd: number | null;
  remainingCapUsd: number | null;
  removed: boolean;
}


const toNum = (s: string): number | null | "bad" => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : "bad";
};
const toDate = (s: string): number | null => (s ? new Date(`${s}T23:59:59`).getTime() : null);
const fromDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

export function AddPaidKeyForm({ providers }: { providers: string[] }) {
  const [provider, setProvider] = useState(providers.length === 1 ? providers[0]! : "");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [billing, setBilling] = useState<string>("paid_postpaid");
  const [cap, setCap] = useState("");
  const [balance, setBalance] = useState("");
  const [expires, setExpires] = useState("");
  const { run, busy, error, errors, message, setError } = useAction();
  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const c = toNum(cap);
        const b = toNum(balance);
        if (c === "bad" || b === "bad") {
          setError("Cap and balance must be numbers (or empty).");
          return;
        }
        const r = await run(
          "/api/paid/keys",
          "POST",
          { provider, label, secret, billingClass: billing, monthlyCapUsd: c, prepaidBalanceUsd: b, expiresAt: toDate(expires) },
          { success: "Key stored in the encrypted vault. Only its last four characters are ever shown." },
        );
        // The secret is cleared whether or not the request succeeded; it is never kept in the page.
        setSecret("");
        if (r.ok) {
          setLabel("");
          setCap("");
          setBalance("");
          setExpires("");
        }
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="block text-sm text-ink-2">
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="field mt-1" required>
            <option value="" disabled>
              Choose…
            </option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink-2">
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-1" placeholder="e.g. team card" maxLength={80} />
        </label>
        <label className="block text-sm text-ink-2">
          API key
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="field mt-1 font-mono" placeholder="paste the key" autoComplete="new-password" required minLength={8} />
        </label>
        <label className="block text-sm text-ink-2">
          <span className="inline-flex items-center gap-1">
            Billing class <HelpTip term="billingClass" />
          </span>
          <select value={billing} onChange={(e) => setBilling(e.target.value)} className="field mt-1">
            {BILLING_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {BILLING_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink-2">
          Monthly cap (USD, optional)
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" className="field tabular mt-1" placeholder="no cap" />
        </label>
        <label className="block text-sm text-ink-2">
          Prepaid balance (USD, optional)
          <input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" className="field tabular mt-1" placeholder="not tracked" />
        </label>
        <label className="block text-sm text-ink-2">
          Expires (optional)
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className="field mt-1" />
        </label>
      </div>
      <p className="text-xs text-ink-3">The key is encrypted at rest (AES-256-GCM) and used only for direct requests to this provider. It is never shown again; the panel shows its last four characters.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass("primary")} disabled={busy || !provider || secret.length < 8}>
          <Plus size={14} aria-hidden /> Add key
        </button>
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </form>
  );
}

export function PaidKeyRow({ k }: { k: PaidKeyView }) {
  const { run, busy, error, errors, message, setError } = useAction();
  const [editing, setEditing] = useState(false);
  const [arming, setArming] = useState(false);
  const [label, setLabel] = useState(k.label);
  const [billing, setBilling] = useState(k.billingClass);
  const [cap, setCap] = useState(k.monthlyCapUsd?.toString() ?? "");
  const [balance, setBalance] = useState(k.prepaidBalanceUsd?.toString() ?? "");
  const [expires, setExpires] = useState(fromDate(k.expiresAt));
  const expired = k.expiresAt !== null && k.expiresAt < Date.now();

  const save = async () => {
    const c = toNum(cap);
    const b = toNum(balance);
    if (c === "bad" || b === "bad") return setError("Cap and balance must be numbers (or empty).");
    const patch: Record<string, unknown> = {};
    if (label !== k.label) patch.label = label;
    if (billing !== k.billingClass) patch.billingClass = billing;
    if (c !== k.monthlyCapUsd) patch.monthlyCapUsd = c;
    // Setting the balance restarts its tracking from now.
    if (b !== k.prepaidBalanceUsd) patch.prepaidBalanceUsd = b;
    if (toDate(expires) !== (k.expiresAt ? toDate(fromDate(k.expiresAt)) : null)) patch.expiresAt = toDate(expires);
    if (!Object.keys(patch).length) return setEditing(false);
    const r = await run(`/api/paid/keys/${k.id}`, "PATCH", patch, { success: "Saved" });
    if (r.ok) setEditing(false);
  };

  return (
    <tr className={cx(!k.enabled && "opacity-75")}>
      <td>
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-ink-3" aria-hidden />
          <span className="font-medium text-ink">{k.provider}</span>
        </div>
      </td>
      <td>
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="field w-40" aria-label="Label" />
        ) : (
          <>
            <div className="text-ink">{k.label || <span className="text-ink-3">no label</span>}</div>
            <div className="text-[11px] text-ink-3">added {dateTime(k.createdAt)}</div>
          </>
        )}
      </td>
      <td>
        {editing ? (
          <select value={billing} onChange={(e) => setBilling(e.target.value)} className="field w-44" aria-label="Billing class">
            {BILLING_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {BILLING_LABEL[b]}
              </option>
            ))}
          </select>
        ) : (
          <Badge tone={k.billingClass === "free_tier" ? "good" : k.billingClass === "trial" ? "accent" : "neutral"}>{BILLING_LABEL[k.billingClass] ?? k.billingClass}</Badge>
        )}
      </td>
      <td className="font-mono text-xs text-ink-2">{k.removed ? <span className="font-sans text-ink-3">secret removed</span> : `••••${k.last4}`}</td>
      <td className="tabular text-right">{usd(k.spent30d)}</td>
      <td className="tabular text-xs">
        {editing ? (
          <div className="space-y-1">
            <input value={cap} onChange={(e) => setCap(e.target.value)} className="field w-28" placeholder="cap: none" aria-label="Monthly cap in USD" />
            <input value={balance} onChange={(e) => setBalance(e.target.value)} className="field w-28" placeholder="balance: none" aria-label="Prepaid balance in USD" />
          </div>
        ) : (
          <div className="space-y-0.5">
            <div>{k.monthlyCapUsd !== null ? <>cap {usd(k.remainingCapUsd)} left of {usd(k.monthlyCapUsd)}</> : <span className="text-ink-3">no monthly cap</span>}</div>
            <div>{k.prepaidBalanceUsd !== null ? <>balance {usd(k.remainingBalanceUsd)} of {usd(k.prepaidBalanceUsd)}</> : <span className="text-ink-3">balance not tracked</span>}</div>
          </div>
        )}
      </td>
      <td className="whitespace-nowrap text-xs">
        {editing ? (
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className="field w-36" aria-label="Expiry date" />
        ) : k.expiresAt ? (
          <span className={expired ? "text-bad-ink" : "text-ink-2"}>{expired ? "expired " : ""}{new Date(k.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span>
        ) : (
          <span className="text-ink-3">never</span>
        )}
      </td>
      <td className="text-right">
        <div className="inline-flex items-center gap-1">
          {k.removed ? (
            <Badge title="Removed keys with spend stay listed so spend history stays complete">kept for history</Badge>
          ) : editing ? (
            <>
              <button type="button" className={buttonClass("primary", true)} disabled={busy} onClick={() => void save()}>
                <Check size={13} aria-hidden /> Save
              </button>
              <button type="button" className={buttonClass("ghost", true)} onClick={() => setEditing(false)}>
                <X size={13} aria-hidden /> Cancel
              </button>
            </>
          ) : (
            <>
              <label className="mr-1 inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                <input type="checkbox" role="switch" className="sr-only" checked={k.enabled} disabled={busy} onChange={(e) => run(`/api/paid/keys/${k.id}`, "PATCH", { enabled: e.target.checked })} />
                <span className={cx("relative h-5 w-9 rounded-full transition-colors", k.enabled ? "bg-accent" : "bg-surface-3")} aria-hidden>
                  <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", k.enabled ? "left-4.5" : "left-0.5")} />
                </span>
                {k.enabled ? "Enabled" : "Disabled"}
              </label>
              <button type="button" className={buttonClass("ghost", true)} onClick={() => setEditing(true)} aria-label="Edit key">
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
                  await run(`/api/paid/keys/${k.id}`, "DELETE", undefined, { success: "Key removed" });
                }}
                aria-label="Remove key"
              >
                <Trash2 size={13} aria-hidden /> {arming ? "Remove permanently?" : ""}
              </button>
            </>
          )}
        </div>
        {error || message ? (
          <div className="mt-1 text-left">
            <ActionStatus error={error} message={message} errors={errors} />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/** Billing class selector for a FreeLLMAPI key (stored by SwitchYard, not FreeLLMAPI). */
export function FreeKeyBilling({ id, platform, current }: { id: number; platform: string; current: string }) {
  const { run, busy, error } = useAction();
  return (
    <span className="inline-flex flex-col gap-1">
      <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
        Billing <HelpTip term="billingClass" />
        <select value={current} disabled={busy} onChange={(e) => run(`/api/keys/${id}/billing`, "POST", { platform, billingClass: e.target.value })} className="field w-auto py-0.5 text-xs" aria-label="Billing class">
          {["free_tier", "paid_credits", "paid_postpaid", "trial"].map((b) => (
            <option key={b} value={b}>
              {b === "paid_postpaid" ? "Billed to card" : b === "paid_credits" ? "Paid credits" : BILLING_LABEL[b]}
            </option>
          ))}
        </select>
      </label>
      {current !== "free_tier" ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-warn-ink">
          <TriangleAlert size={11} aria-hidden /> Blocks {platform} from free routing
        </span>
      ) : null}
      {error ? <span className="text-[11px] text-bad-ink">{error}</span> : null}
    </span>
  );
}
