import { z } from "zod";
import { assertCriticalStoreDurability,readStoreIdentity,type StoreIdentity } from "../projects/store-identity.js";
import { createHash } from "node:crypto";
import type { Db } from "../storage/db.js";
import { DEFAULT_COOLDOWN_MS, MAX_DEFAULT_COOLDOWN_MS, OUT_OF_CREDITS_RECHECK_MS } from "../providers/keys.js";
import type { ProviderErrorKind } from "../providers/errors.js";

/**
 * Health of each web backend key (`web_backend_state`), kept in the store so every process
 * sharing it sees the same state, like provider key state:
 * - a 429 or a 5xx, timeout, or dropped connection cools the key for the wait the backend named,
 *   else 30 s doubling with consecutive failures up to 15 minutes;
 * - 401/403 marks it invalid until the key changes or is re-enabled;
 * - 402 or a spend message marks it out of credits, rechecked after 6 hours;
 * - a success clears it and records when it was last used (the `spread` strategy's order).
 * A key whose secret changed (a new key under the same env var or vault entry) starts clean.
 */

export type WebKeyStatus = "ok" | "cooling" | "invalid" | "out_of_credits";

export interface WebKeyState {
  ref: string;
  backend: string;
  status: WebKeyStatus;
  /** When a cooling or out-of-credits key may be tried again; null otherwise. */
  until: number | null;
  failures: number;
  lastUsedAt: number | null;
  lastError: string | null;
}

interface Row {
  ref: string;
  backend: string;
  status: WebKeyStatus;
  until: number | null;
  failures: number;
  last_used_at: number | null;
  last_error: string | null;
  secret_fp: string | null;
  updated_at: number;
}

/** A short fingerprint of a secret (never the secret): a changed key resets its state. */
export function secretFingerprint(secret: string | null): string | null {
  return secret === null ? null : createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export class WebBackendState {
  private pinned:StoreIdentity|null=null;
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {this.owner();}
  usesDatabase(db:Db):boolean{return this.db===db;}
  private owner():boolean{const current=readStoreIdentity(this.db);if(current?.role==="project")throw new Error("Shared web backend state cannot use a project store");if(current){assertCriticalStoreDurability(this.db);if(this.pinned&&JSON.stringify(this.pinned)!==JSON.stringify(current))throw new Error("Web backend coordination identity changed");this.pinned??=current;}return current!==null;}


  private row(ref: string): Row | undefined {
    this.owner();const raw=this.db.prepare("SELECT * FROM web_backend_state WHERE ref = ?").get(z.string().min(1).max(300).parse(ref));if(!raw)return undefined;
    return z.object({ref:z.string(),backend:z.string(),status:z.enum(["ok","cooling","invalid","out_of_credits"]),until:z.number().nullable(),failures:z.number().int().nonnegative(),last_used_at:z.number().nullable(),last_error:z.string().nullable(),secret_fp:z.string().nullable(),updated_at:z.number()}).strict().parse(raw);
  }

  /** The key's state; a key whose secret changed since it was recorded reads as fresh. */
  get(ref: string, backend: string, secret: string | null): WebKeyState {
    const r = this.row(ref);
    const fp = secretFingerprint(secret);
    if (!r || (r.secret_fp !== null && fp !== null && r.secret_fp !== fp)) return { ref, backend, status: "ok", until: null, failures: 0, lastUsedAt: r?.last_used_at ?? null, lastError: null };
    return { ref, backend: r.backend, status: r.status, until: r.until, failures: r.failures, lastUsedAt: r.last_used_at, lastError: this.owner()&&r.last_error?`backend_${r.status}`:r.last_error };
  }

  /** Whether the key may be tried now: ok, or cooling / out of credits whose wait has passed. */
  available(s: WebKeyState): boolean {
    if (s.status === "ok") return true;
    if (s.status === "invalid") return false;
    return s.until !== null && s.until <= this.now();
  }

  private write(ref: string, backend: string, secret: string | null, v: { status: WebKeyStatus; until: number | null; failures: number; lastUsedAt: number | null; lastError: string | null }): void {
    this.owner();
    this.db
      .prepare(
        `INSERT INTO web_backend_state (ref, backend, status, until, failures, last_used_at, last_error, secret_fp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET backend = excluded.backend, status = excluded.status, until = excluded.until, failures = excluded.failures,
           last_used_at = excluded.last_used_at, last_error = excluded.last_error, secret_fp = excluded.secret_fp, updated_at = excluded.updated_at`,
      )
      .run(ref, backend, v.status, v.until, v.failures, v.lastUsedAt, v.lastError, secretFingerprint(secret), this.now());
  }

  /** Mark the key as chosen now (before the request), so concurrent calls spread to other keys. */
  touch(ref: string, backend: string, secret: string | null): void {
    const s = this.get(ref, backend, secret);
    this.write(ref, backend, secret, { status: s.status, until: s.until, failures: s.failures, lastUsedAt: this.now(), lastError: s.lastError });
  }

  succeeded(ref: string, backend: string, secret: string | null): void {
    this.write(ref, backend, secret, { status: "ok", until: null, failures: 0, lastUsedAt: this.now(), lastError: null });
  }

  /**
   * Record a failure. Returns the state now held, or null when the failure says nothing about the
   * key (a bad request, a policy refusal, an unknown result): the call still moves on.
   */
  failed(ref: string, backend: string, secret: string | null, reason: ProviderErrorKind, message: string, retryAfterMs: number | null): WebKeyState | null {
    const s = this.get(ref, backend, secret);
    const now = this.now();
    const shared=this.owner();
    const lastError = shared ? z.enum(["rate_limited","auth_invalid","out_of_credits","not_in_plan","policy","server","timeout","transport","bad_request","unknown_model","aborted"]).parse(reason) : message.slice(0, 300);
    let next: { status: WebKeyStatus; until: number | null; failures: number };
    if (reason === "rate_limited" || reason === "server" || reason === "timeout" || reason === "transport") {
      const failures = s.failures + 1;
      const wait = retryAfterMs ?? Math.min(DEFAULT_COOLDOWN_MS * 2 ** (failures - 1), MAX_DEFAULT_COOLDOWN_MS);
      next = { status: "cooling", until: now + Math.max(1000, wait), failures };
    } else if (reason === "auth_invalid") next = { status: "invalid", until: null, failures: s.failures + 1 };
    else if (reason === "out_of_credits" || reason === "not_in_plan") next = { status: "out_of_credits", until: now + OUT_OF_CREDITS_RECHECK_MS, failures: s.failures + 1 };
    else return null;
    this.write(ref, backend, secret, { ...next, lastUsedAt: s.lastUsedAt, lastError });
    return { ref, backend, ...next, lastUsedAt: s.lastUsedAt, lastError };
  }

  /** Forget a key's state (a re-enabled or replaced key). */
  clear(ref: string): void {
    this.owner();this.db.prepare("DELETE FROM web_backend_state WHERE ref = ?").run(ref);
  }
}
