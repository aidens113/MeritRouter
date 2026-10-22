import { expect, it } from "vitest";
import { labCheckMatchesHeads, type LabCheckResult } from "../src/labs/checks.js";
import { BrowserEvidenceSchema } from "../src/labs/browser-schema.js";

it("rejects stale browser evidence after another repository advances or the environment changes", () => {
  const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
  const browser = BrowserEvidenceSchema.parse({ mode: "static", scriptsExecuted: false,
    assertions: [], console: [], pageErrors: [], violations: [], blockedConnections: 0,
    blockedTargets: 0, requests: 1, responseBytes: 1, heads: { app: a, api: b }, artifacts: [] });
  const check: Pick<LabCheckResult, "repository" | "revision" | "browser"> = { repository: "app", revision: a, browser };
  expect(labCheckMatchesHeads(check, { app: a, api: b })).toBe(true);
  expect(labCheckMatchesHeads(check, { app: a, api: c })).toBe(false);
  expect(labCheckMatchesHeads(check, { app: a })).toBe(false);
  expect(labCheckMatchesHeads(check, { app: a, api: b, extra: c })).toBe(false);
  expect(labCheckMatchesHeads({ ...check, browser: { ...browser, heads: {} } }, { app: a, api: b })).toBe(false);
  expect(labCheckMatchesHeads({ repository: "app", revision: a }, { app: a, api: c })).toBe(true);
});
