import "server-only";
import type { FreeLlmApiKey } from "switchyard-router";

/** Key metadata safe to send to the browser. Secrets are write-only and never leave the server. */
export interface SafeKey {
  id: number;
  platform: string;
  label: string;
  status: string;
  enabled: boolean;
  groupLabel: string | null;
  createdAt: string | null;
  lastCheckedAt: string | null;
}

export function safeKey(k: FreeLlmApiKey): SafeKey {
  const raw = k as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
  return {
    id: Number(k.id),
    platform: String(k.platform),
    label: String(k.label ?? ""),
    status: String(k.status ?? "unknown"),
    enabled: Boolean(k.enabled),
    groupLabel: str(k.groupLabel) ?? str(raw.group_label),
    createdAt: str(k.created_at) ?? str(raw.createdAt),
    lastCheckedAt: str(k.last_checked_at) ?? str(raw.lastCheckedAt),
  };
}

/** GET /api/keys/providers has no documented shape; accept strings or objects with an id/name. */
export function normalizeProviders(raw: unknown): Array<{ id: string; name: string }> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? ((raw as Record<string, unknown>).providers ?? Object.keys(raw as object)) : [];
  const out: Array<{ id: string; name: string }> = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === "string") out.push({ id: item, name: item });
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id = [o.platform, o.id, o.name, o.key].find((v) => typeof v === "string") as string | undefined;
      if (id) out.push({ id, name: (typeof o.displayName === "string" ? o.displayName : typeof o.name === "string" ? o.name : id) as string });
    }
  }
  return [...new Map(out.map((p) => [p.id, p])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
