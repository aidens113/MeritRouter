import { GatewayError } from "../core/errors.js";

/**
 * Client for FreeLLMAPI's dashboard routes under /api (verified at server v0.2.1). These
 * require a dashboard session token (POST /api/auth/login), not the unified inference key.
 */
export interface FreeLlmApiProfile {
  id: number;
  name: string;
  type: string;
  auto_include_new_models: number;
}

export interface FreeLlmApiProfileModel {
  model_db_id: number;
  priority: number;
  enabled: boolean;
  platform: string;
  model_id: string;
  display_name: string | null;
  size_label: string | null;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

/** Catalog row from GET /api/models (routes/models.ts, server v0.2.1). */
export interface FreeLlmApiModel {
  id: number;
  platform: string;
  modelId: string;
  displayName: string | null;
  sizeLabel: string | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  source: string;
  hasProvider: boolean;
  keyCount: number;
}

/** Key metadata as listed by FreeLLMAPI. The secret itself is never returned by list. */
export interface FreeLlmApiKey {
  id: number;
  platform: string;
  label: string;
  status: string;
  enabled: boolean;
  groupLabel?: string | null;
  created_at?: string;
  last_checked_at?: string | null;
  [extra: string]: unknown;
}

export class FreeLlmApiAdmin {
  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // Inference lives under /v1; admin routes under /api on the same origin.
    this.root = new URL(baseUrl).origin;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GatewayError("transport", `cannot reach FreeLLMAPI admin API: ${(err as Error).message}`, undefined, undefined, false);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 300);
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "unknown_model" : "server";
      throw new GatewayError(kind, `admin ${method} ${path}: HTTP ${res.status} ${msg}`, res.status, undefined, false);
    }
    return json as T;
  }

  listProfiles(): Promise<FreeLlmApiProfile[]> {
    return this.call("GET", "/api/profiles");
  }

  profileModels(profileId: number): Promise<FreeLlmApiProfileModel[]> {
    return this.call("GET", `/api/profiles/${profileId}/models`);
  }

  /** Create a curated chain that starts empty and never auto-includes new catalog models. */
  createEmptyProfile(name: string): Promise<FreeLlmApiProfile> {
    return this.call("POST", "/api/profiles", { name, empty: true });
  }

  /** Replace a chain's members (PUT /api/profiles/:id/reorder deletes and re-inserts rows). */
  setProfileMembers(profileId: number, members: Array<{ modelDbId: number; priority: number; enabled: boolean }>): Promise<unknown> {
    return this.call("PUT", `/api/profiles/${profileId}/reorder`, members);
  }

  /** Full FreeLLMAPI catalog (GET /api/models). */
  listModels(): Promise<FreeLlmApiModel[]> {
    return this.call("GET", "/api/models");
  }

  listKeys(): Promise<FreeLlmApiKey[]> {
    return this.call<FreeLlmApiKey[] | { keys: FreeLlmApiKey[] }>("GET", "/api/keys").then((r) =>
      Array.isArray(r) ? r : r.keys,
    );
  }

  listProviders(): Promise<unknown> {
    return this.call("GET", "/api/keys/providers");
  }

  addKey(input: { platform: string; label?: string; key: string }): Promise<unknown> {
    return this.call("POST", "/api/keys", input);
  }

  updateKey(id: number, patch: { enabled?: boolean; label?: string; groupLabel?: string | null }): Promise<unknown> {
    return this.call("PATCH", `/api/keys/${id}`, patch);
  }

  deleteKey(id: number): Promise<unknown> {
    return this.call("DELETE", `/api/keys/${id}`);
  }
}
