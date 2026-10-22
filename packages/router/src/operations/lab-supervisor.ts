import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SwitchyardError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";

const KEY = "lab_supervisor_v1";
const TTL = 15_000;
const State = z.object({ owner: z.string().regex(/^[a-f0-9]{48}$/), pid: z.number().int().positive(), configPath: z.string().min(1), expiresAt: z.number().int(), ready: z.boolean(), stopRequested: z.boolean() }).strict();
export type LabSupervisorState = z.infer<typeof State>;

/** A renewable singleton lease; no PID is used as authority to terminate a process. */
export class LabSupervisorLease {
  readonly owner = randomBytes(24).toString("hex");
  constructor(readonly db: Db, readonly configPath: string, readonly now: () => number = Date.now) {}
  read(): LabSupervisorState | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(KEY) as { value: string } | undefined;
    return row ? State.parse(JSON.parse(row.value)) : null;
  }
  private write(state: LabSupervisorState): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(State.parse(state)));
  }
  claim(): LabSupervisorState {
    return immediate(this.db, () => {
      const current = this.read();
      if (current && current.expiresAt > this.now()) throw new SwitchyardError("conflict", "a Labs supervisor already holds the install lease");
      const state = { owner: this.owner, pid: process.pid, configPath: this.configPath, expiresAt: this.now() + TTL, ready: false, stopRequested: false };
      this.write(state);
      return state;
    });
  }
  heartbeat(ready = true): LabSupervisorState {
    return immediate(this.db, () => {
      const current = this.read();
      if (!current || current.owner !== this.owner || current.expiresAt <= this.now()) throw new SwitchyardError("conflict", "Labs supervisor lease expired or changed owner");
      const state = { ...current, ready, expiresAt: this.now() + TTL };
      this.write(state);
      return state;
    });
  }
  requestStop(): boolean {
    return immediate(this.db, () => {
      const current = this.read();
      if (!current || current.expiresAt <= this.now()) return false;
      this.write({ ...current, stopRequested: true });
      return true;
    });
  }
  release(): void {
    immediate(this.db, () => {
      if (this.read()?.owner === this.owner) this.db.prepare("DELETE FROM meta WHERE key=?").run(KEY);
    });
  }
}
