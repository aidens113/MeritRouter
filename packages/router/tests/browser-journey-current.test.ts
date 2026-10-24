import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ checks: [] as any[], snapshot: {} as any, fixture: "", endpoint: {} as any, engine: "engine", image: `sha256:${"2".repeat(64)}`, artifactValid: true }));
vi.mock("../src/labs/checks.js", () => ({ labChecks: () => state.checks }));
vi.mock("../src/labs/browser-journey-evidence.js", async (original) => ({ ...await original<typeof import("../src/labs/browser-journey-evidence.js")>(), journeySourceSnapshot: async () => state.snapshot, journeyInputsDigest: async () => state.fixture }));
vi.mock("../src/labs/browser-network.js", () => ({ ownedBrowserEndpoint: async () => state.endpoint }));
vi.mock("../src/labs/browser-docker.js", () => ({ probeDockerBrowser: async () => ({ engineId: state.engine, imageId: state.image }) }));
vi.mock("../src/labs/browser-artifacts.js", () => ({
  browserCheckDirectory: () => "fixture-only", readBrowserScreenshot: () => {
    if (!state.artifactValid)
      throw new Error("artifact corrupt"); return Buffer.from("fixture");
  }
}));
import { resolveCurrentJourneyCandidate } from "../src/labs/browser-journey-current.js";
import { journeyEnvironmentDigest } from "../src/labs/browser-journey-evidence.js";
import { BrowserJourneyCheckSchema, BrowserJourneyEvidenceSchema } from "../src/labs/browser-journey-schema.js";
import { productDigest } from "../src/verification/product-spec.js";
import type { LabManager } from "../src/labs/lab.js";
import type { LabRecord } from "../src/labs/store.js";
let lab: LabRecord;
const specDigest = "1".repeat(64), before = "a".repeat(64), after = "b".repeat(64), head = "c".repeat(40), tree = "d".repeat(40), dependency = "e".repeat(64);
beforeEach(() => {
  const check = BrowserJourneyCheckSchema.parse({ kind: "browser", mode: "interactive", service: "web", isolation: { backend: "docker_network_none_v1", executable: process.execPath, endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine", image: `fixture/browser@sha256:${"a".repeat(64)}`, browser: "/usr/bin/chromium" }, specDigest, steps: [{ id: "observe", criterionIds: ["primary"], action: "assert", assertion: { kind: "exists", selector: "#saved" } }] });
  lab = { id: "lab", project: "alpha", name: "example", root: "fixture-only", recipe: { data: [], checks: { journey: check } } } as unknown as LabRecord;
  state.endpoint = { origin: "http://127.0.0.1:5100", pid: 123, token: "private-owned-token", port: 5100 };
  state.engine = "engine";
  state.image = `sha256:${"2".repeat(64)}`;
  state.artifactValid = true;
  state.fixture = after;
  state.snapshot = { heads: { app: head }, trees: { app: tree }, dependencyDigest: dependency };
  const evidence = BrowserJourneyEvidenceSchema.parse({ schemaVersion: 1, mode: "interactive", scriptsEnabled: true, status: "passed", cleanup: "complete", isolation: { backend: "docker_network_none_v1", generation: "3".repeat(32), engineId: state.engine, imageId: state.image }, browser: { product: "Chrome fixture", protocolVersion: "1.3" }, heads: { app: head }, trees: { app: tree }, specDigest, testDigest: productDigest(check.steps), recipeDigest: productDigest(lab.recipe), environmentDigest: "0".repeat(64), dependencyDigest: dependency, fixtureDigest: before, fixtureAfterDigest: after, resourceDigest: productDigest([]), serviceIdentities: [productDigest(state.endpoint)], steps: [{ id: "observe", criterionIds: ["primary"], action: "assert", passed: true, durationMs: 1, detail: "fixture-only observed assertion" }], console: [], pageErrors: [], violations: [], requests: 1, responseBytes: 100, artifacts: [{ id: "lba_fixture", mediaType: "image/png", bytes: 8, sha256: "f".repeat(64) }], unknowns: [] });
  evidence.environmentDigest = journeyEnvironmentDigest(evidence);
  state.checks = [{ id: "lc_fixture", name: "journey", repository: "app", revision: head, exitCode: 0, killed: null, journey: evidence }];
});
const resolve = () => resolveCurrentJourneyCandidate({ store: {} } as LabManager, lab, specDigest, new AbortController().signal);
describe("Current runtime identity binding (logical fixtures, not a browser certification)", () => {
  it("preserves exact observed initial input identity only while actual final state/environment still match", async () => {
    const bound = await resolve();
    expect(bound?.candidate).toMatchObject({ repositories: { app: { head, tree } }, fixtureDigest: before, browserGeneration: "3".repeat(32), dependencyDigest: dependency });
    expect(state.fixture).not.toBe(before);
  });
  it.each(["head", "tree", "dependencies", "fixture", "service", "engine", "image", "artifact", "recipe", "steps"])("invalidates changed %s rather than reusing old runtime identity", async (kind) => {
    if (kind === "head")
      state.snapshot.heads.app = "0".repeat(40);
    if (kind === "tree")
      state.snapshot.trees.app = "0".repeat(40);
    if (kind === "dependencies")
      state.snapshot.dependencyDigest = "0".repeat(64);
    if (kind === "fixture")
      state.fixture = "0".repeat(64);
    if (kind === "service")
      state.endpoint.pid = 456;
    if (kind === "engine")
      state.engine = "other-engine";
    if (kind === "image")
      state.image = `sha256:${"0".repeat(64)}`;
    if (kind === "artifact")
      state.artifactValid = false;
    if (kind === "recipe")
      (lab.recipe.checks.journey as any).path = "/changed";
    if (kind === "steps")
      state.checks[0].journey.steps[0].criterionIds = ["unobserved"];
    expect(await resolve()).toBeNull();
  });
  it("does not fall back to an older pass after a newer failed or unavailable journey", async () => {
    const good = state.checks[0], bad = structuredClone(good);
    bad.id = "lc_failed";
    bad.exitCode = 1;
    bad.journey.status = "failed";
    state.checks = [bad, good];
    expect(await resolve()).toBeNull();
    bad.journey.status = "unavailable";
    expect(await resolve()).toBeNull();
  });
});
