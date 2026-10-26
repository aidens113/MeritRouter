import type { Db } from "../storage/db.js";
import { isSearchService } from "../web/services.js";
import type { ResolvedConfig } from "../config/load.js";
import type { KeyVault, PaidKey } from "../providers/vault.js";
import type { ProviderCredential } from "../providers/credentials.js";
import type { ProjectLimits } from "../projects/schema.js";
import { ACCOUNTING_SPEND_SQL, assertAccountingOverlap } from "../admission/accounting-usage.js";

const DAY = 86_400_000;

export interface SpendSummary {
  day: number;
  week: number;
  month: number;
  budgets: { perDayUsd: number | null; perWeekUsd: number; perMonthUsd: number | null };
  keys: Array<PaidKey & { spent30d: number; remainingBalanceUsd: number | null; remainingCapUsd: number | null }>;
  byEndpoint: Array<{ endpointId: string; requests: number; usd: number }>;
}

/**
 * A key as the spend ledger sees it. `ref` is the credential ref (`vault:<id>`, or
 * `config:<provider>:...` for a key declared in config), so a config key keeps its spend across
 * restarts. Only vault keys carry a monthly cap or a prepaid balance.
 */
export interface SpendKey {
  ref: string;
  label: string;
  enabled: boolean;
  monthlyCapUsd: number | null;
  prepaidBalanceUsd: number | null;
  balanceCheckedAt: number | null;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Paid spend ledger, keyed by credential ref. Reservations count as spent until settled to the actual cost. */
export class PaidSpend {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly vault: KeyVault,
    private readonly now: () => number = Date.now,
  ) {}

  /** Host-only wiring check for atomic global accounting adapters. */
  usesDatabase(db: Db): boolean { return this.db === db; }

  /**
   * The ledger's view of a credential: a vault key with its cap and balance (null when the vault
   * no longer has it), or a config key with neither (only global and task budgets apply to it).
   */
  spendKey(cred: Pick<ProviderCredential, "ref" | "vaultKeyId" | "label" | "enabled">): SpendKey | null {
    if (cred.vaultKeyId === null) return { ref: cred.ref, label: cred.label, enabled: cred.enabled, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null };
    const k = this.vault.get(cred.vaultKeyId);
    if (!k) return null;
    return { ref: cred.ref, label: k.label, enabled: k.enabled && !k.removed, monthlyCapUsd: k.monthlyCapUsd, prepaidBalanceUsd: k.prepaidBalanceUsd, balanceCheckedAt: k.balanceCheckedAt };
  }

  private sum(where: string, ...args: unknown[]): number {
    assertAccountingOverlap(this.db);
    return (this.db.prepare(`WITH spend AS (${ACCOUNTING_SPEND_SQL}) SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS s FROM spend WHERE ${where}`).get(...args) as { s: number }).s;
  }

  windowSpend(sinceMs: number): number {
    return this.sum("created_at > ?", sinceMs);
  }

  keySpendSince(keyRef: string, sinceMs: number): number {
    return this.sum("key_ref = ? AND created_at > ?", keyRef, sinceMs);
  }

  taskSpend(taskId: string): number {
    assertAccountingOverlap(this.db);
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(p.actual_usd, p.reserved_usd) * 1.0 / (SELECT COUNT(*) FROM request_charges c2 WHERE c2.request_id = p.request_id)), 0) AS s
             FROM (${ACCOUNTING_SPEND_SQL}) p JOIN request_charges c ON c.request_id = p.request_id WHERE c.task_id = ?`,
        )
        .get(taskId) as { s: number }
    ).s;
  }

  /** Paid spend of one project's requests since `sinceMs` (attributed by `model_requests.project_id`). */
  projectSpendSince(project: string, sinceMs: number): number {
    assertAccountingOverlap(this.db);
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(p.actual_usd, p.reserved_usd)), 0) AS s
             FROM (${ACCOUNTING_SPEND_SQL}) p WHERE p.created_at > ? AND (
               EXISTS(SELECT 1 FROM model_requests r WHERE r.id=p.request_id AND r.project_id=?)
               OR p.project_uuid IN (SELECT project_uuid FROM project_store_registrations WHERE slug=?))`,
        )
        .get(sinceMs, project, project) as { s: number }
    ).s;
  }

  /** Immutable split-project accounting; unmapped legacy history is held conservatively, never guessed from a reused slug. */
  projectAccountingSpendSince(projectId: string, sinceMs: number): number {
    return this.sum("created_at > ? AND (project_uuid=? OR project_uuid IS NULL)", sinceMs, projectId);
  }

  /**
   * A project's own paid windows (decision D7), inside the global ones. Returns a reason when the
   * worst case would exceed one, else null; unset windows never deny.
   */
  projectDenial(project: string, budgets: ProjectLimits["paid_budgets"], worstUsd: number): string | null {
    if (!budgets) return null;
    const now = this.now();
    const checks: Array<[string, number | undefined, number]> = [
      ["daily", budgets.per_day_usd, now - DAY],
      ["weekly", budgets.per_week_usd, now - 7 * DAY],
      ["monthly", budgets.per_month_usd, now - 30 * DAY],
    ];
    for (const [name, limit, since] of checks) {
      if (limit === undefined) continue;
      const spent = this.projectSpendSince(project, since);
      if (spent + worstUsd > limit) return `project ${project} ${name} paid budget: ${spent.toFixed(4)} spent + ${worstUsd.toFixed(4)} worst case exceeds ${limit}`;
    }
    return null;
  }

  /** Remaining headroom for a key: the smaller of its monthly cap and its prepaid balance. */
  keyHeadroom(k: SpendKey): number {
    const now = this.now();
    let room = Infinity;
    if (k.monthlyCapUsd !== null) room = Math.min(room, k.monthlyCapUsd - this.keySpendSince(k.ref, now - 30 * DAY));
    if (k.prepaidBalanceUsd !== null) room = Math.min(room, k.prepaidBalanceUsd - this.keySpendSince(k.ref, k.balanceCheckedAt ?? 0));
    return room;
  }

  /** Global windows. Returns a reason when the worst case would exceed one, else null. */
  globalDenial(worstUsd: number): string | null {
    if (this.db.prepare("SELECT 1 FROM physical_requests WHERE cost_quarantined=1 LIMIT 1").get()) return "unreconciled unexpected provider cost blocks paid routing";
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

  record(requestId: string, keyRef: string, provider: string, endpointId: string, reservedUsd: number): void {
    this.db
      .prepare("INSERT INTO paid_spend (request_id, key_ref, provider, endpoint_id, reserved_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(requestId, keyRef, provider, endpointId, round(reservedUsd), this.now());
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
      keys: this.vault
        .list()
        .filter((k) => !isSearchService(k.provider))
        .map((k) => {
        const ref = `vault:${k.id}`;
        return {
          ...k,
          spent30d: round(this.keySpendSince(ref, now - 30 * DAY)),
          remainingBalanceUsd: k.prepaidBalanceUsd === null ? null : round(k.prepaidBalanceUsd - this.keySpendSince(ref, k.balanceCheckedAt ?? 0)),
          remainingCapUsd: k.monthlyCapUsd === null ? null : round(k.monthlyCapUsd - this.keySpendSince(ref, now - 30 * DAY)),
        };
      }),
      byEndpoint: this.db
        .prepare(`WITH spend AS (${ACCOUNTING_SPEND_SQL}) SELECT endpoint_id AS endpointId, COUNT(*) AS requests, ROUND(COALESCE(SUM(COALESCE(actual_usd, reserved_usd)),0), 6) AS usd FROM spend WHERE created_at > ? GROUP BY endpoint_id ORDER BY usd DESC`)
        .all(now - 30 * DAY) as SpendSummary["byEndpoint"],
    };
  }
}

/**
 * USD per million tokens: input, output, and (when known) input served from the provider's
 * prompt cache. Without `cachedIn`, cached input is priced as ordinary input.
 */
export interface TokenPrice {
  in: number;
  out: number;
  cachedIn?: number | null;
  cacheWriteIn?: number | null;
  /** USD per native web search the provider runs inside the request (unset: no search is priced). */
  perSearch?: number | null;
}

/** An endpoint's prices as a `TokenPrice`; unknown input or output prices are Infinity (never routable as free). */
export function endpointPrice(pricing: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; cachedInputUsdPerMillion?: number | null | undefined; cacheWriteInputUsdPerMillion?: number | null | undefined }): TokenPrice {
  return { in: pricing.inputUsdPerMillion ?? Infinity, out: pricing.outputUsdPerMillion ?? Infinity, cachedIn: pricing.cachedInputUsdPerMillion ?? null, cacheWriteIn: pricing.cacheWriteInputUsdPerMillion ?? null };
}

/** Input estimates are approximate; reserve this much headroom over them for paid requests. */
export const PAID_INPUT_SAFETY = 1.5;

/**
 * Worst-case USD for a request: the input estimate with a safety margin (tokenizers differ;
 * dense text such as base64 tokenizes worse than ~3 characters per token) plus the full output
 * allowance. Reasoning tokens count inside max_tokens for the supported APIs. `maxSearches`
 * native web searches are added at `price.perSearch` (an unknown search price is Infinity).
 */
export function worstCaseUsd(inputTokens: number, maxOutputTokens: number, price: TokenPrice, maxSearches = 0): number {
  return (Math.ceil(inputTokens * PAID_INPUT_SAFETY) * Math.max(price.in, price.cachedIn ?? price.in, price.cacheWriteIn ?? price.in) + maxOutputTokens * price.out) / 1_000_000 + searchUsd(maxSearches, price);
}

/** Cost of `searches` native web searches; an unknown per-search price makes any search Infinity. */
export function searchUsd(searches: number, price: Pick<TokenPrice, "perSearch">): number {
  if (searches <= 0 || price.perSearch === undefined) return 0;
  return price.perSearch === null ? Infinity : searches * price.perSearch;
}

/**
 * Cost of a served request. `cachedInputTokens` (a subset of `inputTokens`) are priced at the
 * cached rate when one is known. Cache creation is a separate subset, using only its configured
 * or verified price. Unknown write prices return Infinity. `searches` native web searches are added at
 * `price.perSearch`.
 */
export function actualUsd(inputTokens: number, outputTokens: number, price: TokenPrice, cachedInputTokens = 0, searches = 0, cacheCreationInputTokens = 0): number {
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const created = Math.min(Math.max(0, cacheCreationInputTokens), inputTokens - cached);
  // Unknown write price can never silently become ordinary input. Gate disables such writes.
  if (created > 0 && price.cacheWriteIn == null) return Infinity;
  const cachedRate = price.cachedIn ?? price.in;
  return ((inputTokens - cached - created) * price.in + cached * cachedRate + created * (price.cacheWriteIn ?? 0) + outputTokens * price.out) / 1_000_000 + searchUsd(searches, price);
}

/** What reading `cachedInputTokens` from the cache saved over ordinary input; null without a cached price. */
export function cacheSavingUsd(cachedInputTokens: number, price: TokenPrice): number | null {
  if (price.cachedIn === null || price.cachedIn === undefined || !Number.isFinite(price.in)) return null;
  return (Math.max(0, cachedInputTokens) * Math.max(0, price.in - price.cachedIn)) / 1_000_000;
}
