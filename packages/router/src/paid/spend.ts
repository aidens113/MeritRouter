import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { KeyVault, PaidKey } from "./vault.js";

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

/** Paid spend ledger. Reservations count as spent until settled to the actual cost. */
export class PaidSpend {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly vault: KeyVault,
    private readonly now: () => number = Date.now,
  ) {}

  key(id: number): PaidKey | null {
    return this.vault.get(id);
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
      .prepare("INSERT INTO paid_spend (request_id, key_id, provider, endpoint_id, reserved_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(requestId, keyId, provider, endpointId, round(reservedUsd), this.now());
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

/** Worst-case USD for a request: every input token plus the full output allowance. */
export function worstCaseUsd(inputTokens: number, maxOutputTokens: number, price: { in: number; out: number }): number {
  return (inputTokens * price.in + maxOutputTokens * price.out) / 1_000_000;
}

export function actualUsd(inputTokens: number, outputTokens: number, price: { in: number; out: number }): number {
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}
