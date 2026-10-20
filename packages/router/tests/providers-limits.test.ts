import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProvidersSectionSchema } from "../src/config/schema.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import {
  DAY_MS,
  DEFAULT_COOLDOWN_MS,
  MINUTE_MS,
  OUT_OF_CREDITS_RECHECK_MS,
  ProviderCredentials,
  ProviderError,
  ProviderKeys,
  ProviderLimits,
  limitScopes,
  nextUtcMidnight,
  currentError,
  probeFreeDailyQuota,
  providerHealth,
  providerStatuses,
  resolveProviders,
  type FetchLike,
  type KeySelectOptions,
  type ProviderCredential,
  type RateLimitSnapshot,
  type ResolvedProvider,
} from "../src/providers/index.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

let dir: string | undefined;
let db: Db | undefined;
let clock = T0;
const now = () => clock;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  clock = T0;
});

function store(): Db {
  dir ??= mkdtempSync(path.join(os.tmpdir(), "sy-limits-"));
  db = openDatabase(dir);
  return db;
}

interface Setup {
  providers: Map<string, ResolvedProvider>;
  creds: ProviderCredentials;
  groq: ResolvedProvider;
  list: (id?: string) => ProviderCredential[];
}

const ENV: Record<string, string> = { GROQ_A: "gsk_aaaa_1111", GROQ_B: "gsk_bbbb_2222", GROQ_C: "gsk_cccc_3333", OR_KEY: "sk-or-v1-zzzz" };

function setup(section: Record<string, unknown> = {}, env: Record<string, string> = ENV): Setup {
  const parsed = ProvidersSectionSchema.parse({
    groq: { keys: ["GROQ_A", "GROQ_B", "GROQ_C"].map((v) => ({ label: v, api_key_env: v, billing_class: "free_tier" })) },
    ...section,
  });
  const providers = resolveProviders(parsed);
  const creds = new ProviderCredentials(providers, parsed, null, env, now);
  return { providers, creds, groq: providers.get("groq")!, list: (id = "groq") => creds.list(id) };
}

const ref = (v: string) => `config:groq:env:${v}`;
const rateLimited = (retryAfterMs?: number) => new ProviderError("rate_limited", "groq HTTP 429: slow down", { provider: "groq", status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

function pick(keys: ProviderKeys, s: Setup, opts: KeySelectOptions = {}): string | null {
  return keys.select(s.groq, s.list(), opts).credential?.ref ?? null;
}

describe("key rotation", () => {
  it("rotates round-robin in declared order, skips a cooling key, and brings it back after the cooldown", () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup();
    expect([pick(keys, s), pick(keys, s), pick(keys, s), pick(keys, s)]).toEqual([ref("GROQ_A"), ref("GROQ_B"), ref("GROQ_C"), ref("GROQ_A")]);

    // A 429 on B (next in line) cools it: the caller retries and gets C, then A.
    keys.recordFailure(s.list()[1]!, rateLimited(10_000));
    expect(keys.get(ref("GROQ_B"))).toMatchObject({ cooldownUntil: T0 + 10_000, consecutiveFailures: 1, provider: "groq" });
    const sel = keys.select(s.groq, s.list());
    expect(sel.credential?.ref).toBe(ref("GROQ_C"));
    expect(sel.blocked).toEqual([expect.objectContaining({ ref: ref("GROQ_B"), reason: "cooling", until: T0 + 10_000 })]);
    expect(pick(keys, s)).toBe(ref("GROQ_A"));
    expect(pick(keys, s, { exclude: [ref("GROQ_C")] })).toBe(ref("GROQ_A"));

    clock = T0 + 10_000;
    expect(pick(keys, s)).toBe(ref("GROQ_B"));
    keys.recordSuccess(s.list()[1]!, null);
    expect(keys.get(ref("GROQ_B"))).toMatchObject({ cooldownUntil: null, consecutiveFailures: 0, lastSuccessAt: T0 + 10_000 });
  });

  it("uses the snapshot's wait, else a doubling default, and reports when every key is cooling", () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup();
    const snapshot: RateLimitSnapshot = { family: "openai", observedAt: T0, retryAfterMs: null, windows: [{ metric: "requests", period: "day", limit: 1000, remaining: 0, resetAt: T0 + 90_000 }] };
    keys.recordFailure(ref("GROQ_A"), new ProviderError("rate_limited", "429", { provider: "groq", status: 429, rateLimits: snapshot }));
    expect(keys.get(ref("GROQ_A"))!.cooldownUntil).toBe(T0 + 90_000);
    keys.recordFailure(ref("GROQ_B"), rateLimited());
    expect(keys.get(ref("GROQ_B"))!.cooldownUntil).toBe(T0 + DEFAULT_COOLDOWN_MS);
    keys.recordFailure(ref("GROQ_B"), rateLimited());
    expect(keys.get(ref("GROQ_B"))!.cooldownUntil).toBe(T0 + 2 * DEFAULT_COOLDOWN_MS);
    keys.recordFailure(ref("GROQ_C"), rateLimited(5_000));
    const none = keys.select(s.groq, s.list());
    expect(none.credential).toBeNull();
    expect(none.credential === null && none.resumeAt).toBe(T0 + 5_000);
    expect(none.blocked.map((b) => b.reason)).toEqual(["cooling", "cooling", "cooling"]);
  });

  it("skips a key whose last snapshot shows an exhausted window until it resets", () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup();
    keys.recordSuccess(s.list()[0]!, { family: "openai", observedAt: T0, retryAfterMs: null, windows: [{ metric: "tokens", period: "minute", limit: 6000, remaining: 500, resetAt: T0 + 20_000 }] });
    // 500 tokens left: a 400-token request fits, an 800-token one does not.
    expect(pick(keys, s, { estimatedTokens: 400 })).toBe(ref("GROQ_A"));
    const big = keys.select(s.groq, s.list(), { estimatedTokens: 800, exclude: [ref("GROQ_B"), ref("GROQ_C")] });
    expect(big.credential).toBeNull();
    expect(big.blocked.find((b) => b.ref === ref("GROQ_A"))).toMatchObject({ reason: "exhausted", until: T0 + 20_000 });
    clock = T0 + 20_000;
    expect(pick(keys, s, { estimatedTokens: 800, exclude: [ref("GROQ_B"), ref("GROQ_C")] })).toBe(ref("GROQ_A"));
  });

  it("disables an invalid key until it is cleared or its secret changes, and rechecks out-of-credit keys", () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup();
    const [a, b] = s.list();
    keys.recordFailure(a!, new ProviderError("auth_invalid", "groq HTTP 401: invalid api key", { provider: "groq", status: 401 }));
    expect(keys.get(a!.ref)).toMatchObject({ disabledReason: "auth_invalid", last4: "1111" });
    clock = T0 + 30 * DAY_MS;
    expect([pick(keys, s), pick(keys, s), pick(keys, s)]).not.toContain(a!.ref);

    // The user puts a new secret in the same env var: same ref, different key.
    const fresh = setup({}, { ...ENV, GROQ_A: "gsk_new_9999" });
    expect(keys.select(fresh.groq, fresh.list(), { exclude: [ref("GROQ_B"), ref("GROQ_C")] }).credential?.ref).toBe(a!.ref);
    keys.recordFailure(a!.ref, new ProviderError("auth_invalid", "401", { provider: "groq", status: 401 }));
    keys.clear(a!.ref);
    expect(keys.get(a!.ref)!.disabledReason).toBeNull();

    clock = T0;
    keys.recordFailure(b!, new ProviderError("out_of_credits", "402", { provider: "groq", status: 402 }));
    const sel = keys.select(s.groq, s.list(), { exclude: [ref("GROQ_A"), ref("GROQ_C")] });
    expect(sel.credential).toBeNull();
    expect(sel.blocked.find((x) => x.ref === b!.ref)).toMatchObject({ reason: "out_of_credits", until: T0 + OUT_OF_CREDITS_RECHECK_MS });
    clock = T0 + OUT_OF_CREDITS_RECHECK_MS;
    expect(pick(keys, s, { exclude: [ref("GROQ_A"), ref("GROQ_C")] })).toBe(b!.ref);
  });

  it("ignores failures that say nothing about the key", () => {
    const keys = new ProviderKeys(store(), now);
    keys.recordFailure(ref("GROQ_A"), new ProviderError("bad_request", "400", { provider: "groq", status: 400 }));
    keys.recordFailure(ref("GROQ_A"), new ProviderError("unknown_model", "404", { provider: "groq", status: 404 }));
    expect(keys.get(ref("GROQ_A"))).toBeNull();
    keys.recordFailure(ref("GROQ_A"), new ProviderError("server", "500", { provider: "groq", status: 500 }));
    expect(keys.get(ref("GROQ_A"))).toMatchObject({ consecutiveFailures: 1, cooldownUntil: null, disabledReason: null, lastError: "server: 500" });
  });
});

describe("configured limits", () => {
  it("enforces a per-key rpm as a sliding window", () => {
    const db = store();
    const keys = new ProviderKeys(db, now);
    const limits = new ProviderLimits(db, now);
    const s = setup({ groq: { keys: [{ api_key_env: "GROQ_A", billing_class: "free_tier", rpm: 2 }] } });
    expect(pick(keys, s, { limits })).toBe(ref("GROQ_A"));
    clock = T0 + 10_000;
    expect(pick(keys, s, { limits })).toBe(ref("GROQ_A"));
    clock = T0 + 20_000;
    const blocked = keys.select(s.groq, s.list(), { limits });
    expect(blocked.credential).toBeNull();
    expect(blocked.blocked[0]).toMatchObject({ reason: "limit", until: T0 + MINUTE_MS });
    expect(limits.usage(`key:${ref("GROQ_A")}`)).toEqual({ requestsMinute: 2, requestsDay: 2, tokensMinute: 0, tokensDay: 0 });
    clock = T0 + MINUTE_MS;
    expect(pick(keys, s, { limits })).toBe(ref("GROQ_A"));
  });

  it("enforces provider-level limits across keys and quota-group limits across members", () => {
    const db = store();
    const keys = new ProviderKeys(db, now);
    const limits = new ProviderLimits(db, now);
    const s = setup({
      groq: {
        rpd: 3,
        keys: [
          { api_key_env: "GROQ_A", billing_class: "free_tier" },
          { api_key_env: "GROQ_B", billing_class: "free_tier" },
          { api_key_env: "GROQ_C", billing_class: "free_tier" },
        ],
      },
    });
    expect([pick(keys, s, { limits }), pick(keys, s, { limits }), pick(keys, s, { limits }), pick(keys, s, { limits })]).toEqual([ref("GROQ_A"), ref("GROQ_B"), ref("GROQ_C"), null]);
    clock = T0 + DAY_MS;
    expect(pick(keys, s, { limits })).not.toBeNull();

    // Two keys in one quota group share the tightest limit a member declares; the third is separate.
    const g = setup({
      groq: {
        keys: [
          { api_key_env: "GROQ_A", billing_class: "free_tier", quota_group: "proj", rpm: 2 },
          { api_key_env: "GROQ_B", billing_class: "free_tier", quota_group: "proj" },
          { api_key_env: "GROQ_C", billing_class: "free_tier", rpm: 1 },
        ],
      },
    });
    expect(limitScopes(g.groq, g.list()[1]!, { siblings: g.list() }).map((x) => [x.id, x.limits.rpm])).toEqual([
      ["provider:groq", null],
      ["group:groq:proj", 2],
    ]);
    const picks = Array.from({ length: 4 }, () => pick(keys, g, { limits }));
    expect(picks.filter((p) => p === ref("GROQ_A") || p === ref("GROQ_B"))).toHaveLength(2);
    expect(picks.filter((p) => p === ref("GROQ_C"))).toHaveLength(1);
    expect(picks[3]).toBeNull();
    expect(limits.usage("group:groq:proj").requestsMinute).toBe(2);
  });

  it("counts tokens, settles them to actual usage, releases unsent requests, and enforces per-model limits", () => {
    const db = store();
    const limits = new ProviderLimits(db, now);
    const scopes = [{ id: "key:k1", limits: { tpm: 1000 } }];
    const r1 = limits.reserve(scopes, 600);
    expect(r1.ok).toBe(true);
    expect(limits.check(scopes, 600)).toMatchObject({ ok: false, blocked: [{ scope: "key:k1", metric: "tpm", limit: 1000, used: 600, resumeAt: T0 + MINUTE_MS }] });
    limits.settle(r1.reservation!, 200);
    expect(limits.check(scopes, 600).ok).toBe(true);
    const r2 = limits.reserve(scopes, 700);
    expect(r2.ok).toBe(true);
    expect(limits.reserve(scopes, 200).ok).toBe(false);
    limits.release(r2.reservation!);
    expect(limits.reserve(scopes, 200).ok).toBe(true);
    // A request larger than the limit never fits.
    expect(limits.check(scopes, 5000)).toMatchObject({ ok: false, resumeAt: null });

    const keys = new ProviderKeys(db, now);
    const s = setup({ groq: { keys: [{ api_key_env: "GROQ_A", billing_class: "free_tier" }] } });
    const model = { model: "llama-3.3-70b-versatile", modelLimits: { rpm: 1, tpd: null }, limits };
    const first = keys.select(s.groq, s.list(), model);
    expect(first.scopes?.map((x) => x.id)).toEqual(["provider:groq", `key:${ref("GROQ_A")}`, `model:key:${ref("GROQ_A")}:llama-3.3-70b-versatile`]);
    expect(keys.select(s.groq, s.list(), model).credential).toBeNull();
    expect(pick(keys, s, { ...model, model: "other-model" })).toBe(ref("GROQ_A"));
  });

  it("keeps key state, rotation, and windows across a reopened store", () => {
    let d = store();
    const s = setup({ groq: { keys: [{ api_key_env: "GROQ_A", billing_class: "free_tier", rpm: 1 }, { api_key_env: "GROQ_B", billing_class: "free_tier" }] } });
    let keys = new ProviderKeys(d, now);
    expect(pick(keys, s, { limits: new ProviderLimits(d, now) })).toBe(ref("GROQ_A"));
    keys.recordFailure(s.list()[1]!, rateLimited(30_000));
    d.close();
    db = undefined;

    d = store();
    keys = new ProviderKeys(d, now);
    const limits = new ProviderLimits(d, now);
    expect(keys.get(ref("GROQ_B"))).toMatchObject({ cooldownUntil: T0 + 30_000 });
    expect(limits.usage(`key:${ref("GROQ_A")}`).requestsMinute).toBe(1);
    const none = keys.select(s.groq, s.list(), { limits });
    expect(none.credential).toBeNull();
    expect(none.blocked.map((b) => b.reason)).toEqual(["cooling", "limit"]);
    clock = T0 + 30_000;
    // B was never chosen, so it is next in the rotation once it has cooled.
    expect(pick(keys, s, { limits })).toBe(ref("GROQ_B"));
  });
});

describe("OpenRouter free daily quota", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function fakeFetch(answer: () => Response): FetchLike & { calls: Array<{ url: string; method: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fn = (async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      return answer();
    }) as FetchLike & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  }

  it("probes /api/v1/key, records the quota, and skips the key for free models once it is used up", async () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup({ openrouter: { keys: [{ api_key_env: "OR_KEY", billing_class: "free_tier" }] } });
    const or = s.providers.get("openrouter")!;
    const f = fakeFetch(() => json({ data: { label: "sk-or-v1-zz", free_model_daily_requests: { used: 50, limit: 50 } } }));
    const quota = await probeFreeDailyQuota({ provider: or, credential: s.creds.requestCredential("config:openrouter:env:OR_KEY"), fetch: f, now });
    expect(f.calls).toEqual([{ url: "https://openrouter.ai/api/v1/key", method: "GET", headers: expect.objectContaining({ authorization: "Bearer sk-or-v1-zzzz" }) }]);
    expect(quota).toEqual({ used: 50, limit: 50, remaining: 0, resetAt: Date.UTC(2026, 9, 21), checkedAt: T0 });
    const cred = s.list("openrouter")[0]!;
    keys.recordQuota(cred, quota!);
    expect(keys.get(cred.ref)!.quota).toEqual(quota);
    expect(keys.select(or, [cred], { freeQuota: true })).toMatchObject({ credential: null, resumeAt: Date.UTC(2026, 9, 21), blocked: [{ reason: "free_quota" }] });
    // Paid models on the same key do not draw on the free quota.
    expect(keys.select(or, [cred]).credential?.ref).toBe(cred.ref);
    clock = Date.UTC(2026, 9, 21);
    expect(keys.select(or, [cred], { freeQuota: true }).credential?.ref).toBe(cred.ref);
  });

  it("returns null when the quota is not reported and classifies HTTP failures", async () => {
    const s = setup({ openrouter: { keys: [{ api_key_env: "OR_KEY", billing_class: "free_tier" }] } });
    const or = s.providers.get("openrouter")!;
    const credential = { apiKey: "sk-or-v1-zzzz" };
    expect(await probeFreeDailyQuota({ provider: or, credential, fetch: fakeFetch(() => json({ data: { label: "x", usage: 0 } })), now })).toBeNull();
    expect(await probeFreeDailyQuota({ provider: or, credential, fetch: fakeFetch(() => json({ data: { free_model_daily_requests: { used: 3, limit: 1000, remaining: 997 } } })), now })).toMatchObject({ remaining: 997 });
    await expect(probeFreeDailyQuota({ provider: or, credential, fetch: fakeFetch(() => json({ error: { code: 401, message: "No auth credentials found" } }, 401)), now })).rejects.toMatchObject({ reason: "auth_invalid" });
    await expect(probeFreeDailyQuota({ provider: s.groq, credential, fetch: fakeFetch(() => json({})), now })).rejects.toThrow(/no key-info endpoint/);
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("provider health", () => {
  it("derives ProviderStatus from key state", () => {
    const db = store();
    const keys = new ProviderKeys(db, now);
    const s = setup();
    const [a, b, c] = s.list();
    expect(providerHealth(s.groq, s.list(), keys).status).toEqual({ platform: "groq", status: "healthy", keys: 3, resumeAt: null, requestsRemainingPct: null, lastError: null });

    keys.recordSuccess(a!, { family: "openai", observedAt: T0, retryAfterMs: null, windows: [{ metric: "requests", period: "day", limit: 1000, remaining: 250, resetAt: T0 + DAY_MS }] });
    keys.recordSuccess(b!, { family: "openai", observedAt: T0, retryAfterMs: null, windows: [{ metric: "requests", period: "day", limit: 1000, remaining: 750, resetAt: T0 + DAY_MS }] });
    expect(providerHealth(s.groq, s.list(), keys).status.requestsRemainingPct).toBe(50);

    keys.recordFailure(a!, rateLimited(40_000));
    keys.recordFailure(b!, rateLimited(20_000));
    clock = T0 + 1;
    keys.recordFailure(c!, new ProviderError("auth_invalid", "groq HTTP 401: bad key", { provider: "groq", status: 401 }));
    const cooling = providerHealth(s.groq, s.list(), keys);
    expect(cooling.status).toMatchObject({ status: "rate_limited", keys: 3, resumeAt: T0 + 20_000, lastError: "auth_invalid: groq HTTP 401: bad key" });
    expect(cooling.keys.map((k) => k.reason)).toEqual(["cooling", "cooling", "auth_invalid"]);

    keys.recordFailure(a!, new ProviderError("auth_invalid", "401", { provider: "groq", status: 401 }));
    keys.recordFailure(b!, new ProviderError("out_of_credits", "402", { provider: "groq", status: 402 }));
    expect(providerHealth(s.groq, s.list(), keys).status.status).toBe("invalid");
    expect(providerStatuses(s.providers, [...s.list(), ...s.list("openrouter")], keys).map((p) => [p.platform, p.status])).toEqual([["groq", "invalid"]]);

    // No usable key (env vars unset) is unknown; configured limits count when given.
    const unset = setup({}, {});
    expect(providerHealth(unset.groq, unset.list(), keys).status).toMatchObject({ status: "unknown", keys: 0 });
    const limited = setup({ groq: { rpm: 1, keys: [{ api_key_env: "GROQ_A", billing_class: "free_tier" }] } }, { GROQ_A: "gsk_other_0000" });
    keys.clear(ref("GROQ_A"));
    const limits = new ProviderLimits(db, now);
    clock = T0;
    limits.reserve(limitScopes(limited.groq, limited.list()[0]!), 0);
    expect(providerHealth(limited.groq, limited.list(), keys, { limits }).status).toMatchObject({ status: "rate_limited", resumeAt: T0 + MINUTE_MS });
  });

  it("reports a key's last error only while no later success on that key resolved it", () => {
    const keys = new ProviderKeys(store(), now);
    const s = setup();
    const [a, b] = s.list();
    const lastError = () => providerHealth(s.groq, s.list(), keys).status.lastError;
    keys.recordFailure(a!, rateLimited(1000));
    expect(lastError()).toBe("rate_limited: groq HTTP 429: slow down");
    expect(currentError(keys.get(a!.ref))).toEqual({ message: "rate_limited: groq HTTP 429: slow down", at: T0 });

    // The same key serves later: the error is history (kept in key state), not health.
    clock = T0 + 5000;
    keys.recordSuccess(a!);
    expect(lastError()).toBeNull();
    expect(currentError(keys.get(a!.ref))).toBeNull();
    expect(keys.get(a!.ref)!.lastError).toMatch(/429/);

    // Another key's success does not resolve this key's newer error.
    clock = T0 + 6000;
    keys.recordFailure(a!, new ProviderError("server", "groq HTTP 503: busy", { provider: "groq", status: 503 }));
    clock = T0 + 7000;
    keys.recordSuccess(b!);
    expect(lastError()).toBe("server: groq HTTP 503: busy");
    expect(currentError(null)).toBeNull();
  });
});
