import test from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/stats.js";

test("averages a list of numbers", () => {
  assert.equal(average([1, 2, 3]), 2);
});

test("throws on an empty array", () => {
  assert.throws(() => average([]), /empty array/);
});
