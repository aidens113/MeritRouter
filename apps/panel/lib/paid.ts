import "server-only";
import type { Switchyard } from "switchyard-router";

export { BILLING_CLASSES, type BillingClass } from "./billing";

/** Paid key metadata safe to send to the browser: an explicit whitelist, never the secret. */
export interface SafePaidKey {
  id: number;
  provider: string;
  label: string;
  billingClass: string;
  enabled: boolean;
  last4: string;
  monthlyCapUsd: number | null;
  prepaidBalanceUsd: number | null;
  balanceCheckedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  spent30d: number | null;
  remainingBalanceUsd: number | null;
  remainingCapUsd: number | null;
  /** Removed keys with spend history keep their row (secret wiped) so the ledger stays complete. */
  removed: boolean;
}

export function safePaidKey(k: Record<string, unknown>, removed: boolean): SafePaidKey {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: Number(k.id),
    provider: String(k.provider),
    label: String(k.label ?? ""),
    billingClass: String(k.billingClass ?? "paid_postpaid"),
    enabled: Boolean(k.enabled),
    last4: String(k.last4 ?? ""),
    monthlyCapUsd: n(k.monthlyCapUsd),
    prepaidBalanceUsd: n(k.prepaidBalanceUsd),
    balanceCheckedAt: n(k.balanceCheckedAt),
    expiresAt: n(k.expiresAt),
    createdAt: Number(k.createdAt ?? 0),
    spent30d: n(k.spent30d),
    remainingBalanceUsd: n(k.remainingBalanceUsd),
    remainingCapUsd: n(k.remainingCapUsd),
    removed,
  };
}

/**
 * Ids of keys whose secret was wiped by removePaidKey (kept because they have spend). The vault
 * does not expose this, so it is read from the table; only the id column is selected.
 */
export function removedKeyIds(sy: Switchyard): Set<number> {
  try {
    return new Set((sy.db.prepare("SELECT id FROM paid_keys WHERE enc = ''").all() as Array<{ id: number }>).map((r) => r.id));
  } catch {
    return new Set();
  }
}
