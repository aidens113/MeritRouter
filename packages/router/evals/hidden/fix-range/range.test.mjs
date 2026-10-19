import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.js";

test("excludes end", () => assert.deepEqual(range(0, 3), [0, 1, 2]));
test("empty when start equals end", () => assert.deepEqual(range(2, 2), []));
test("step", () => assert.deepEqual(range(0, 10, 4), [0, 4, 8]));
