import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/strings.js";

test("slugifies a title", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("trims surrounding punctuation", () => {
  assert.equal(slugify("  --weird--  "), "weird");
});
