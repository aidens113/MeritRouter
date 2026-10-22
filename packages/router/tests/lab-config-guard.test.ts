import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { LabManager } from "../src/labs/lab.js";
import { patchConfig, readConfigText, writePreparedConfigText } from "../src/admin/config-edit.js";
import { previewProjectDeletion } from "../src/admin/projects.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { Switchyard } from "../src/core/service.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
let labs: LabManager | undefined;
afterEach(async () => { await labs?.close(); await sy?.close(); env?.cleanup(); labs = undefined; sy = undefined; env = undefined; });

it("retains project and repository cleanup mappings until the lab is destroyed", async () => {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" }, projects: {
    alpha: { repositories: { app: { path: "repo" } }, lab: {} },
    beta: { repositories: { app: { path: "repo" } } },
  } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  labs = new LabManager({ db: sy.db, storageDir: sy.cfg.storageDir, cfg: sy.cfg, project: slug => sy!.projectContext(slug), monitor: false });
  await labs.create("alpha", "feature");
  const original = readConfigText(sy);
  expect(patchConfig(sy, [{ path: ["projects", "alpha", "repositories", "app", "path"], value: "replacement" }])).toMatchObject({ ok: false, errors: [expect.stringMatching(/retains repository/)] });
  expect(patchConfig(sy, [{ path: ["projects", "alpha", "repositories", "app"], value: null }])).toMatchObject({ ok: false });
  const raw = YAML.parse(original);
  delete raw.projects.alpha;
  raw.brain.project = "beta";
  expect(await writePreparedConfigText(sy, YAML.stringify(raw))).toMatchObject({ ok: false, errors: [expect.stringMatching(/removing its project/)] });
  expect(readConfigText(sy)).toBe(original);
  expect((await previewProjectDeletion(sy, "alpha")).blockers).toContainEqual(expect.stringMatching(/retained lab/));
  await labs.destroy("alpha", "feature");
  expect(patchConfig(sy, [{ path: ["projects", "alpha", "repositories", "app", "path"], value: "replacement" }])).toEqual({ ok: true });
});
