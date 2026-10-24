import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { SessionStore } from "../src/sessions/store.js";
import { purgeProjectRows } from "../src/projects/deletion.js";

let root: string | undefined;
let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function setup() {
  root = mkdtempSync(path.join(os.tmpdir(), "meritrouter-late-session-"));
  db = openDatabase(root);
  return { db, sessions: new SessionStore(db, root) };
}

it("a retained recorder cannot recreate a private error log after actual project purge", () => {
  const { db, sessions } = setup();
  db.prepare("INSERT INTO projects(id,name,created_at) VALUES('deleted','Deleted',1)").run();
  const recorder = sessions.create({ role: "implementer", agentLabel: "late-owner" });
  db.prepare("UPDATE sessions SET project_id='deleted' WHERE id=?").run(recorder.id);
  recorder.note("private content before purge");
  expect(purgeProjectRows(db, "deleted", [])).toMatchObject({ sessions: 1 });
  rmSync(recorder.logPath);
  expect(() => recorder.modelError({ executionId: "old", error: new Error("private late provider failure") })).toThrow(/no longer exists/);
  expect(() => recorder.note("private late callback")).toThrow(/no longer exists/);
  expect(existsSync(recorder.logPath)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) FROM session_events WHERE session_id=?").pluck().get(recorder.id)).toBe(0);
});

it("rejects a changed durable session identity before modifying its log", () => {
  const { db, sessions } = setup();
  const recorder = sessions.create({ role: "analyst", agentLabel: "owner" });
  const before = readFileSync(recorder.logPath, "utf8");
  db.prepare("UPDATE sessions SET created_at=created_at+1 WHERE id=?").run(recorder.id);
  expect(() => recorder.note("stale private content")).toThrow(/identity changed/);
  expect(readFileSync(recorder.logPath, "utf8")).toBe(before);
});

it("keeps durable lines available for recovery when indexing fails", () => {
  const { db, sessions } = setup();
  const recorder = sessions.create({ role: "analyst", agentLabel: "owner" });
  db.exec("CREATE TRIGGER fail_session_index BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'index unavailable'); END");
  expect(() => recorder.note("durable despite index failure")).toThrow(/index unavailable/);
  expect(readFileSync(recorder.logPath, "utf8")).toContain("durable despite index failure");
  expect(recorder.lastSeq).toBe(2);
  expect(sessions.get(recorder.id)?.lastSeq).toBe(1);
  db.exec("DROP TRIGGER fail_session_index");
  expect(sessions.events(recorder.id)?.events.map(event => event.type)).toEqual(["started", "note"]);
});
