import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseDuration } from "../src/index.js";

test("parses compound durations", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("1h0m5s"), 3605);
});
test("round-trips with formatDuration", () => {
  for (const s of [0, 1, 59, 60, 3599, 3600, 86399]) assert.equal(parseDuration(formatDuration(s)), s);
});
test("rejects invalid input", () => {
  for (const bad of ["", "abc", "1x", "h1", "1.5h", "-1m"]) assert.throws(() => parseDuration(bad));
});
test("formatDuration unchanged", () => assert.equal(formatDuration(5400), "1h30m"));
