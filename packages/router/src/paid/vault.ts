import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../storage/db.js";

export const BillingClassSchema = z.enum(["free_tier", "paid_credits", "paid_postpaid", "trial"]);
export type BillingClass = z.infer<typeof BillingClassSchema>;

export const MASTER_KEY_ENV = "SWITCHYARD_MASTER_KEY";
const KEY_FILE = ".master-key";

/** Key metadata. The secret never leaves the vault except to the provider request itself. */
export interface PaidKey {
  id: number;
  provider: string;
  label: string;
  billingClass: BillingClass;
  enabled: boolean;
  last4: string;
  monthlyCapUsd: number | null;
  prepaidBalanceUsd: number | null;
  balanceCheckedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  /** The secret was removed (the key is kept only because it has recorded spend). */
  removed: boolean;
}

export const NewKeySchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9-]+$/),
    label: z.string().max(80).default(""),
    secret: z.string().min(8),
    billingClass: BillingClassSchema.default("paid_postpaid"),
    monthlyCapUsd: z.number().positive().nullable().default(null),
    prepaidBalanceUsd: z.number().min(0).nullable().default(null),
    expiresAt: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type NewKey = z.input<typeof NewKeySchema>;

export const KeyPatchSchema = z
  .object({
    label: z.string().max(80).optional(),
    enabled: z.boolean().optional(),
    billingClass: BillingClassSchema.optional(),
    monthlyCapUsd: z.number().positive().nullable().optional(),
    prepaidBalanceUsd: z.number().min(0).nullable().optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    secret: z.string().min(8).optional(),
  })
  .strict();
export type KeyPatch = z.infer<typeof KeyPatchSchema>;

/**
 * Master key from SWITCHYARD_MASTER_KEY (64 hex chars) or a generated key file in the storage
 * directory (owner-only permissions where the platform supports them).
 */
export function loadMasterKey(storageDir: string): Buffer {
  const env = process.env[MASTER_KEY_ENV];
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error(`${MASTER_KEY_ENV} must be 64 hex characters (32 bytes)`);
    return Buffer.from(env, "hex");
  }
  const file = path.join(storageDir, KEY_FILE);
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  mkdirSync(storageDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: permissions follow the user profile ACLs.
  }
  return key;
}

interface Row {
  id: number;
  provider: string;
  label: string;
  billing_class: BillingClass;
  enc: string;
  iv: string;
  tag: string;
  enabled: number;
  last4: string;
  monthly_cap_usd: number | null;
  prepaid_balance_usd: number | null;
  balance_checked_at: number | null;
  expires_at: number | null;
  created_at: number;
}

const toKey = (r: Row): PaidKey => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  billingClass: r.billing_class,
  enabled: r.enabled === 1,
  last4: r.last4,
  monthlyCapUsd: r.monthly_cap_usd,
  prepaidBalanceUsd: r.prepaid_balance_usd,
  balanceCheckedAt: r.balance_checked_at,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  removed: r.enc === "",
});

/** AES-256-GCM encrypted store for direct paid-provider keys. Several keys per provider. */
export class KeyVault {
  private master: Buffer | null = null;

  constructor(
    private readonly db: Db,
    private readonly storageDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private key(): Buffer {
    this.master ??= loadMasterKey(this.storageDir);
    return this.master;
  }

  private encrypt(secret: string): { enc: string; iv: string; tag: string } {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
  }

  list(provider?: string): PaidKey[] {
    const rows = (provider
      ? this.db.prepare("SELECT * FROM paid_keys WHERE provider = ? ORDER BY id").all(provider)
      : this.db.prepare("SELECT * FROM paid_keys ORDER BY provider, id").all()) as Row[];
    return rows.map(toKey);
  }

  get(id: number): PaidKey | null {
    const r = this.db.prepare("SELECT * FROM paid_keys WHERE id = ?").get(id) as Row | undefined;
    return r ? toKey(r) : null;
  }

  add(input: NewKey): PaidKey {
    const k = NewKeySchema.parse(input);
    const e = this.encrypt(k.secret);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO paid_keys (provider, label, billing_class, enc, iv, tag, enabled, last4, monthly_cap_usd, prepaid_balance_usd, balance_checked_at, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(k.provider, k.label, k.billingClass, e.enc, e.iv, e.tag, k.secret.slice(-4), k.monthlyCapUsd, k.prepaidBalanceUsd, k.prepaidBalanceUsd === null ? null : this.now(), k.expiresAt, this.now()).lastInsertRowid,
    );
    return this.get(id)!;
  }

  update(id: number, patch: KeyPatch): PaidKey {
    const p = KeyPatchSchema.parse(patch);
    const current = this.get(id);
    if (!current) throw new Error(`unknown key ${id}`);
    if (current.removed && p.enabled === true && p.secret === undefined) throw new Error(`key ${id} was removed; set a new secret to use it again`);
    const set = (col: string, v: unknown) => this.db.prepare(`UPDATE paid_keys SET ${col} = ? WHERE id = ?`).run(v, id);
    if (p.label !== undefined) set("label", p.label);
    if (p.enabled !== undefined) set("enabled", p.enabled ? 1 : 0);
    if (p.billingClass !== undefined) set("billing_class", p.billingClass);
    if (p.monthlyCapUsd !== undefined) set("monthly_cap_usd", p.monthlyCapUsd);
    if (p.expiresAt !== undefined) set("expires_at", p.expiresAt);
    if (p.prepaidBalanceUsd !== undefined) {
      set("prepaid_balance_usd", p.prepaidBalanceUsd);
      set("balance_checked_at", p.prepaidBalanceUsd === null ? null : this.now());
    }
    if (p.secret !== undefined) {
      const e = this.encrypt(p.secret);
      this.db.prepare("UPDATE paid_keys SET enc = ?, iv = ?, tag = ?, last4 = ? WHERE id = ?").run(e.enc, e.iv, e.tag, p.secret.slice(-4), id);
    }
    return this.get(id)!;
  }

  remove(id: number): void {
    this.db.prepare("UPDATE paid_keys SET enabled = 0, enc = '', iv = '', tag = '' WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM paid_keys WHERE id = ? AND NOT EXISTS (SELECT 1 FROM paid_spend WHERE key_id = ?)").run(id, id);
  }

  /** Decrypt for a provider request. Not exposed through any listing interface. */
  secret(id: number): string {
    const r = this.db.prepare("SELECT enc, iv, tag FROM paid_keys WHERE id = ?").get(id) as Pick<Row, "enc" | "iv" | "tag"> | undefined;
    if (!r || !r.enc) throw new Error(`key ${id} has no secret`);
    const d = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(r.iv, "base64"));
    d.setAuthTag(Buffer.from(r.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(r.enc, "base64")), d.final()]).toString("utf8");
  }

  /** Keys that are enabled, not expired, and not free-tier (free-tier direct keys are allowed too). */
  usable(provider: string): PaidKey[] {
    const now = this.now();
    return this.list(provider).filter((k) => k.enabled && !k.removed && (k.expiresAt === null || k.expiresAt > now));
  }
}
