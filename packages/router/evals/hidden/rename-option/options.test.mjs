import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOptions, DEFAULTS } from "../src/config.js";
import { createClient } from "../src/client.js";
import { createServer } from "../src/server.js";

test("new option is in seconds", () => {
  assert.equal(DEFAULTS.timeout, 5);
  assert.equal(resolveOptions({ timeout: 3 }).timeout, 3);
  assert.equal(createClient({ timeout: 3 }).deadline(1000), 4000);
  assert.equal(createServer({ timeout: 3 }).idleCutoffMs, 6000);
});
test("deprecated timeoutMs still works and is converted", () => {
  assert.equal(resolveOptions({ timeoutMs: 2500 }).timeout, 2.5);
  assert.equal(createClient({ timeoutMs: 2000 }).deadline(0), 2000);
});
test("resolved options no longer expose timeoutMs", () => {
  assert.equal("timeoutMs" in resolveOptions({}), false);
  assert.equal("timeoutMs" in resolveOptions({ timeoutMs: 1000 }), false);
});
test("describe reports seconds", () => assert.match(createClient({ timeout: 7 }).describe(), /timeout=7s/));
