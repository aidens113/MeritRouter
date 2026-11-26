import test from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "../src/palindrome.js";

test("recognises a palindrome with punctuation and mixed case", () => {
  assert.equal(isPalindrome("A man a plan a canal Panama"), true);
});

test("rejects a non-palindrome", () => {
  assert.equal(isPalindrome("hello"), false);
});

test("treats the empty string as a palindrome", () => {
  assert.equal(isPalindrome(""), true);
});
