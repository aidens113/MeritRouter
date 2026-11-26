import test from "node:test";
import assert from "node:assert/strict";
import { legacySlugify } from "../src/strings.js";

test("slugifies a title", () => {
  assert.equal(legacySlugify("Hello, World!"), "hello-world");
});

test("trims surrounding punctuation", () => {
  assert.equal(legacySlugify("  --weird--  "), "weird");
});
