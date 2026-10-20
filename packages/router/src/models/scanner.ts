import type { Db } from "../storage/db.js";
import type { Catalog } from "./catalog.js";
import type { DiscoveryRun } from "../providers/discovery-run.js";

export interface ScanSummary {
  /** Models the providers listed in this scan. */
  scanned: number;
  /** Endpoint ids not stored before this scan. */
  added: string[];
  pendingConfirmation: string[];
  unavailable: string[];
  /** Providers whose model list was read. */
  providers: string[];
  errors: string[];
}

export interface ScannerDeps {
  db: Db;
  catalog: Catalog;
  /** Run provider discovery (null when no provider has a usable key). */
  discover: () => Promise<DiscoveryRun | null>;
  /** Refresh configured paid model prices; returns error messages. */
  refreshPrices: () => Promise<string[]>;
  /** Whether any provider is set up at all (keys, or configured paid providers). */
  anyProvider: () => boolean;
  now: () => number;
}

/**
 * A model scan (`models scan`, the panel's Scan button, and the worker's scheduled run): list
 * every provider with a usable key through discovery, refresh configured paid prices, and record
 * the run and its summary in `scans` so the panel can show the last one.
 */
export class Scanner {
  constructor(private readonly deps: ScannerDeps) {}

  async scan(): Promise<ScanSummary> {
    const { db, catalog } = this.deps;
    const scanId = Number(db.prepare("INSERT INTO scans (started_at) VALUES (?)").run(this.deps.now()).lastInsertRowid);
    const summary: ScanSummary = { scanned: 0, added: [], pendingConfirmation: [], unavailable: [], providers: [], errors: [] };
    try {
      const run = await this.deps.discover();
      if (run) {
        summary.scanned = run.endpoints.length;
        summary.added.push(...run.added);
        summary.unavailable.push(...run.unavailable.map((u) => u.endpoint.id));
        for (const p of run.providers) {
          if (p.status === "listed") summary.providers.push(p.provider);
          for (const e of p.errors) summary.errors.push(`${p.provider} (${e.ref}): ${e.message}`);
        }
        summary.errors.push(...run.warnings);
      } else if (!this.deps.anyProvider()) {
        summary.errors.push("no provider has a usable key: add one under providers in the config, or in the panel's Provider keys page");
      }
    } catch (err) {
      summary.errors.push((err as Error).message);
    }
    summary.errors.push(...(await this.deps.refreshPrices()).map((e) => `paid prices ${e}`));
    for (const ep of catalog.endpoints()) if (ep.status === "pending_confirmation") summary.pendingConfirmation.push(ep.id);
    db.prepare("UPDATE scans SET finished_at = ?, ok = ?, summary_json = ? WHERE id = ?").run(this.deps.now(), summary.errors.length === 0 ? 1 : 0, JSON.stringify(summary), scanId);
    return summary;
  }

  lastScan(): { startedAt: number; finishedAt: number | null; ok: boolean | null; summary: ScanSummary | null } | null {
    const r = this.deps.db.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 1").get() as
      | { started_at: number; finished_at: number | null; ok: number | null; summary_json: string | null }
      | undefined;
    if (!r) return null;
    return { startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === null ? null : r.ok === 1, summary: r.summary_json ? (JSON.parse(r.summary_json) as ScanSummary) : null };
  }
}
