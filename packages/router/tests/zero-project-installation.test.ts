import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { doctorChecks, webChecks } from "../src/cli/doctor.js";
import { calibrationOverview } from "../src/admin/calibration.js";
import { readConfigText } from "../src/admin/config-edit.js";
import { modelsView, qualificationBoard, routingPreview, rulebookText } from "../src/admin/insights.js";
import { globalSettings } from "../src/admin/project-settings.js";
import { projectList, projectsGrid } from "../src/admin/projects.js";
import { paidSummary, providerKeysView } from "../src/admin/provider-keys.js";
import { qualificationComparisons, qualificationTasks } from "../src/admin/qualification-work.js";
import { globalKnowledge, promotionsView } from "../src/admin/promotions.js";
import { webSearchView } from "../src/admin/web-search.js";
import { liveChanges, liveCursor } from "../src/admin/live.js";
import { baseConfig, FakeProvider, makeEnv, open, type Env } from "./helpers.js";

// A fresh split installation (storage.layout: split, projects: {}) before its first project
// exists. Every view the panel's /all/** and top-level pages (and doctor) read must either
// return an empty/graceful result or throw a clear MeritRouterError — never crash on an
// undefined `projects.primary`.

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function zeroProjectSplit(): MeritRouter {
  env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: {} }) });
  sy = open(env, new FakeProvider());
  return sy;
}

describe("a split installation with zero projects", () => {
  it("has the split layout with no projects and no primary", () => {
    const sy = zeroProjectSplit();
    expect(sy.layout).toBe("split");
    expect(sy.projects.list()).toEqual([]);
    expect(() => sy.projects.primary).toThrow(/no_project|no project/);
  });

  it("the primary project's accessors (web, brain, brainAccess) throw a clear MeritRouterError instead of crashing", () => {
    const sy = zeroProjectSplit();
    for (const read of [() => sy.web, () => sy.brain, () => sy.brainAccess]) {
      let caught: unknown;
      try {
        read();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: unknown }).code).toBe("no_project");
    }
  });

  it("doctor runs clean with a warning instead of a project check", () => {
    const sy = zeroProjectSplit();
    const checks = doctorChecks(sy);
    const projectsCheck = checks.find((c) => c.check === "projects");
    expect(projectsCheck?.level).toBe("warn");
    expect(webChecks(sy)[0]?.level).not.toBe("fail");
  });

  it("every /all/** and top-level admin view used by the panel runs without throwing", async () => {
    const sy = zeroProjectSplit();

    expect(projectsGrid(sy, { includeArchived: true })).toEqual([]);
    expect(projectList(sy, { includeArchived: true })).toEqual([]);

    const knowledge = await globalKnowledge(sy);
    expect(knowledge.lessons).toEqual([]);
    expect(knowledge.reverts).toEqual([]);
    expect(promotionsView(sy)).toEqual([]);

    const calibration = calibrationOverview(sy, { sinceMs: Date.now() - 30 * 86_400_000 });
    expect(calibration.totals).toBeTruthy();

    const keys = providerKeysView(sy);
    expect(Array.isArray(keys.providers)).toBe(true);
    expect(paidSummary(sy)).toBeTruthy();
    const web = webSearchView(sy, { recent: 0 });
    expect(web.status.on).toBe(false);

    // Models are install-wide (not project-scoped): the catalog still lists them.
    expect(Array.isArray(modelsView(sy))).toBe(true);

    const board = qualificationBoard(sy);
    expect(Array.isArray(board.rows)).toBe(true);
    expect(qualificationTasks(sy, { limit: 50 })).toEqual([]);
    expect(qualificationComparisons(sy, { limit: 10 })).toEqual([]);

    expect(readConfigText(sy)).toContain("version");
    expect(rulebookText(sy).text.length).toBeGreaterThan(0);
    expect(globalSettings(sy)).toBeTruthy();

    for (const profile of Object.keys(sy.cfg.profiles)) {
      for (const tier of ["T1", "T2", "T3"] as const) {
        expect(() => routingPreview(sy, profile as never, tier)).not.toThrow();
      }
    }

    // The panel's live-update stream (`/api/live`) polls this for every page, scope "all".
    const cursor = liveCursor(sy, "all");
    expect(() => liveChanges(sy, cursor)).not.toThrow();
  });

  it("adding and re-enabling a provider or search key does not need a project", () => {
    const sy = zeroProjectSplit();
    const added = sy.vault.add({ provider: "openrouter", secret: "a-test-secret-value", label: "test", billingClass: "free_tier" });
    expect(() => sy.vault.update(added.id, { enabled: true })).not.toThrow();
  });
});
