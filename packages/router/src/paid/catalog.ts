import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { ModelEndpointInput } from "../models/catalog.js";

export function paidEndpointId(provider: string, model: string): string {
  return `paid:${provider}/${model}`;
}

interface FetchedPrice {
  in: number;
  out: number;
  fetchedAt: number;
}

function fetchedPrices(db: Db, provider: string): Record<string, FetchedPrice> {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(`paid_prices:${provider}`) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as Record<string, FetchedPrice>) : {};
}

/** Refresh prices for providers with a pricing_url (OpenRouter-style /models). */
export async function refreshPaidPrices(db: Db, cfg: ResolvedConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const errors: string[] = [];
  for (const [name, p] of Object.entries(cfg.paid.providers)) {
    if (!p.pricing_url) continue;
    try {
      const res = await fetchImpl(p.pricing_url, { signal: AbortSignal.timeout(20_000) });
      const body = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
      const prices: Record<string, FetchedPrice> = {};
      for (const m of body.data ?? []) {
        const pin = Number(m.pricing?.prompt);
        const pout = Number(m.pricing?.completion);
        if (Number.isFinite(pin) && Number.isFinite(pout)) prices[m.id] = { in: pin * 1e6, out: pout * 1e6, fetchedAt: Date.now() };
      }
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`paid_prices:${name}`, JSON.stringify(prices));
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return errors;
}

/**
 * Configured paid models as catalog endpoints. They route directly (never via FreeLLMAPI), are
 * available only with a usable key that may pay (`paidKeys`: vault or config keys that are not
 * `free_tier`), and need a known price to be eligible.
 */
export function paidEndpoints(cfg: ResolvedConfig, db: Db, paidKeys: (provider: string) => number, now = Date.now()): ModelEndpointInput[] {
  return cfg.paid.models.map((m) => {
    const provider = cfg.paid.providers[m.provider]!;
    const fetched = fetchedPrices(db, m.provider)[m.model];
    const pin = m.input_usd_per_million ?? fetched?.in ?? null;
    const pout = m.output_usd_per_million ?? fetched?.out ?? null;
    const keys = paidKeys(m.provider);
    return {
      id: paidEndpointId(m.provider, m.model),
      providerId: `paid:${m.provider}`,
      gatewayModelId: m.model,
      providerModelId: m.model,
      displayName: m.display_name ?? m.model,
      origin: "paid",
      route: { kind: "direct", provider: m.provider, model: m.model },
      ignoreSizeFloor: m.ignore_size_floor,
      totalParametersB: m.declared_parameters_b ?? null,
      activeParametersB: null,
      params: m.declared_parameters_b
        ? { source: "override", confidence: "exact", confirmed: true, evidence: [{ source: "override", totalB: m.declared_parameters_b, activeB: null, detail: "declared in paid.models (closed model size is not published)" }] }
        : { source: "unknown", confidence: "unknown", confirmed: true, evidence: [] },
      contextLimitTokens: m.context_limit_tokens,
      outputLimitTokens: m.output_limit_tokens,
      outputLimitSource: "manual",
      inputModalities: m.input_modalities,
      supportsTools: m.supports_tools,
      supportsStructuredOutput: m.supports_structured_output,
      pricing: {
        inputUsdPerMillion: pin,
        outputUsdPerMillion: pout,
        freeVerified: false,
        source: m.input_usd_per_million !== undefined ? "configured in paid.models" : fetched ? `fetched from ${provider.pricing_url}` : "unknown: set prices or a pricing_url",
      },
      available: cfg.paid.enabled && keys > 0,
      enabled: true,
      quotaScopeIds: [`paid:${m.provider}`],
      sourceUrls: [],
      checkedAt: new Date(fetched?.fetchedAt ?? now).toISOString(),
    };
  });
}

export function paidFingerprint(cfg: ResolvedConfig, db: Db): string {
  const keys = (db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(enabled), 0) AS e, COALESCE(MAX(id), 0) AS m FROM paid_keys").get() as { n: number; e: number; m: number });
  const prices = (db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(length(value)), 0) AS l FROM meta WHERE key LIKE 'paid_prices:%'").get() as { n: number; l: number });
  return `${cfg.paid.enabled}:${cfg.paid.models.length}:${JSON.stringify(cfg.paid.models).length}:${JSON.stringify(cfg.providers).length}:${keys.n}/${keys.e}/${keys.m}:${prices.n}/${prices.l}`;
}
