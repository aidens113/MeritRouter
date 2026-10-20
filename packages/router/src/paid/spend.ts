import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { KeyVault, PaidKey } from "./vault.js";
import type { ProviderCredential } from "../providers/credentials.js";

const DAY = 86_400_000;

export interface SpendSummary {
  day: number;
  week: number;
  month: number;
  budgets: { perDayUsd: number | null; perWeekUsd: number; perMonthUsd: number | null };
  keys: Array<PaidKey & { spent30d: number; remainingBalanceUsd: number | null; remainingCapUsd: number | null }>;
  byEndpoint: Array<{ endpointId: string; requests: number; usd: number }>;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** A stable negative ledger id for a config-declared key (vault ids are positive). */
function configSpendId(ref: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ref.length; i++) h = Math.imul(h ^ ref.charCodeAt(i), 0x01000193);
  return -(1 + ((h >>> 0) & 0x3fffffff));
}

/** Paid spend ledger. Reservations count as spent until settled to the actual cost. */
export class PaidSpend {
  /** Config-declared keys seen by `spendKeyId`, by their negative ledger id. */
  private readonly configKeys = new Map<number, { key: PaidKey; ref: string }>();

  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly vault: KeyVault,
    private readonly now: () => number = Date.now,
  ) {}

  /** A vault key, or a config key registered by `spendKeyId` (no cap or balance: only global and task budgets apply). */
  key(id: number): PaidKey | null {
    if (id < 0) return this.configKeys.get(id)?.key ?? null;
    return this.vault.get(id);
  }

  /** The ledger id a paid request through this credential is recorded under. */
  spendKeyId(cred: Pick<ProviderCredential, "ref" | "vaultKeyId" | "provider" | "label" | "billingClass" | "enabled" | "last4" | "accountId" | "quotaGroup" | "limits">): number {
    if (cred.vaultKeyId !== null) return cred.vaultKeyId;
    const id = configSpendId(cred.ref);
    this.configKeys.set(id, {
      ref: cred.ref,
      key: { id, provider: cred.provider, label: cred.label, billingClass: cred.billingClass, enabled: cred.enabled, last4: cred.last4, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null, expiresAt: null, createdAt: 0, removed: false, accountId: cred.accountId, quotaGroup: cred.quotaGroup, limits: cred.limits },
    });
    return id;
  }

  private sum(where: string, ...args: unknown[]): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS s FROM paid_spend WHERE ${where}`).get(...args) as { s: number }).s;
  }

  windowSpend(sinceMs: number): number {
    return this.sum("created_at > ?", sinceMs);
  }

  keySpendSince(keyId: number, sinceMs: number): number {
    return this.sum("key_id = ? AND created_at > ?", keyId, sinceMs);
  }

  taskSpend(taskId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(p.actual_usd, p.reserved_usd) * 1.0 / (SELECT COUNT(*) FROM request_charges c2 WHERE c2.request_id = p.request_id)), 0) AS s
             FROM paid_spend p JOIN request_charges c ON c.request_id = p.request_id WHERE c.task_id = ?`,
        )
        .get(taskId) as { s: number }
    ).s;
  }

  /** Remaining headroom for a key: the smaller of its monthly cap and its prepaid balance. */
  keyHeadroom(k: PaidKey): number {
    const now = this.now();
    let room = Infinity;
    if (k.monthlyCapUsd !== null) room = Math.min(room, k.monthlyCapUsd - this.keySpendSince(k.id, now - 30 * DAY));
    if (k.prepaidBalanceUsd !== null) room = Math.min(room, k.prepaidBalanceUsd - this.keySpendSince(k.id, k.balanceCheckedAt ?? 0));
    return room;
  }

  /** First usable key for the provider with room for the worst-case cost. */
  pickKey(provider: string, worstUsd: number): PaidKey | null {
    for (const k of this.vault.usable(provider)) if (this.keyHeadroom(k) >= worstUsd) return k;
    return null;
  }

  /** Global windows. Returns a reason when the worst case would exceed one, else null. */
  globalDenial(worstUsd: number): string | null {
    const now = this.now();
    const b = this.cfg.paid.budgets;
    const checks: Array<[string, number | undefined, number]> = [
      ["daily", b.per_day_usd, now - DAY],
      ["weekly", b.per_week_usd, now - 7 * DAY],
      ["monthly", b.per_month_usd, now - 30 * DAY],
    ];
    for (const [name, limit, since] of checks) {
      if (limit === undefined) continue;
      const spent = this.windowSpend(since);
      if (spent + worstUsd > limit) return `${name} paid budget: $${spent.toFixed(4)} spent + $${worstUsd.toFixed(4)} worst case exceeds $${limit}`;
    }
    return null;
  }

  record(requestId: string, keyId: number, provider: string, endpointId: string, reservedUsd: number): void {
    this.db
      .prepare("INSERT INTO paid_spend (request_id, key_id, key_ref, provider, endpoint_id, reserved_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(requestId, keyId, keyId < 0 ? (this.configKeys.get(keyId)?.ref ?? null) : `vault:${keyId}`, provider, endpointId, round(reservedUsd), this.now());
  }

  settle(requestId: string, actualUsd: number, basis: "provider_reported" | "computed" | "not_billed" | "uncertain"): void {
    this.db.prepare("UPDATE paid_spend SET actual_usd = ?, cost_basis = ?, settled_at = ? WHERE request_id = ?").run(round(actualUsd), basis, this.now(), requestId);
  }

  summary(): SpendSummary {
    const now = this.now();
    const b = this.cfg.paid.budgets;
    return {
      day: round(this.windowSpend(now - DAY)),
      week: round(this.windowSpend(now - 7 * DAY)),
      month: round(this.windowSpend(now - 30 * DAY)),
      budgets: { perDayUsd: b.per_day_usd ?? null, perWeekUsd: b.per_week_usd, perMonthUsd: b.per_month_usd ?? null },
      keys: this.vault.list().map((k) => ({
        ...k,
        spent30d: round(this.keySpendSince(k.id, now - 30 * DAY)),
        remainingBalanceUsd: k.prepaidBalanceUsd === null ? null : round(k.prepaidBalanceUsd - this.keySpendSince(k.id, k.balanceCheckedAt ?? 0)),
        remainingCapUsd: k.monthlyCapUsd === null ? null : round(k.monthlyCapUsd - this.keySpendSince(k.id, now - 30 * DAY)),
      })),
      byEndpoint: this.db
        .prepare("SELECT endpoint_id AS endpointId, COUNT(*) AS requests, ROUND(COALESCE(SUM(COALESCE(actual_usd, reserved_usd)),0), 6) AS usd FROM paid_spend WHERE created_at > ? GROUP BY endpoint_id ORDER BY usd DESC")
        .all(now - 30 * DAY) as SpendSummary["byEndpoint"],
    };
  }

  /** FreeLLMAPI platforms that hold a key marked paid: unsafe for free routing. */
  paidFreeLlmApiPlatforms(): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT platform FROM fl_key_billing WHERE billing_class != 'free_tier'").all() as { platform: string }[]).map((r) => r.platform));
  }

  setFreeLlmApiKeyBilling(flKeyId: number, platform: string, billingClass: string): void {
    this.db
      .prepare("INSERT INTO fl_key_billing (fl_key_id, platform, billing_class, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(fl_key_id) DO UPDATE SET platform = excluded.platform, billing_class = excluded.billing_class, updated_at = excluded.updated_at")
      .run(flKeyId, platform, billingClass, this.now());
  }

  freeLlmApiKeyBilling(): Array<{ flKeyId: number; platform: string; billingClass: string }> {
    return (this.db.prepare("SELECT fl_key_id, platform, billing_class FROM fl_key_billing").all() as Array<{ fl_key_id: number; platform: string; billing_class: string }>).map((r) => ({ flKeyId: r.fl_key_id, platform: r.platform, billingClass: r.billing_class }));
  }
}

/** Input estimates are approximate; reserve this much headroom over them for paid requests. */
export const PAID_INPUT_SAFETY = 1.5;

/**
 * Worst-case USD for a request: the input estimate with a safety margin (tokenizers differ;
 * dense text such as base64 tokenizes worse than ~3 characters per token) plus the full output
 * allowance. Reasoning tokens count inside max_tokens for the supported APIs.
 */
export function worstCaseUsd(inputTokens: number, maxOutputTokens: number, price: { in: number; out: number }): number {
  return (Math.ceil(inputTokens * PAID_INPUT_SAFETY) * price.in + maxOutputTokens * price.out) / 1_000_000;
}

export function actualUsd(inputTokens: number, outputTokens: number, price: { in: number; out: number }): number {
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}
