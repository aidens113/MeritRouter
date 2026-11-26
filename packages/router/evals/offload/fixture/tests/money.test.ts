import test from "node:test";
import assert from "node:assert/strict";
import { formatCurrencyCents, clampRange } from "../src/money.js";

test("formats positive cents", () => {
  assert.equal(formatCurrencyCents(1234), "$12.34");
});

test("formats negative cents with the sign before the dollar sign", () => {
  assert.equal(formatCurrencyCents(-150), "-$1.50");
});

test("clampRange keeps an in-range value", () => {
  assert.equal(clampRange(5, 0, 10), 5);
});

test("clampRange clamps below the minimum", () => {
  assert.equal(clampRange(-5, 0, 10), 0);
});
