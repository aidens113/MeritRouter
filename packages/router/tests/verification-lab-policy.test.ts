import { afterEach, expect, it } from "vitest";
import { taskLabPolicyRefusal } from "../src/verification/task-lab-policy.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });
const task = (profile: string, labChecks?: string[]) => ({ spec: { profile, constraints: { acceptanceCriteria: ["x"], ...(labChecks ? { labChecks } : {}) } } }) as never;
function configured(outside: "disabled" | "human_only" | "supervisor") {
  env = makeEnv({ config: baseConfig({ security: { outside_repository: outside } }) });
  return env.cfg;
}

it("names a deterministic policy refusal only for tasks that require Lab checks", () => {
  const cfg = configured("supervisor");
  expect(taskLabPolicyRefusal(cfg, task("implement"))).toBeNull();
  expect(taskLabPolicyRefusal(cfg, task("implement", ["health"]))).toMatch(/implement worker run has no supervisor Lab authority/);
});

it("refuses by the trusted outside-repository policy before anything else", () => {
  expect(taskLabPolicyRefusal(configured("disabled"), task("implement", ["health"]))).toMatch(/disabled by security\.outside_repository/);
  env!.cleanup(); env = undefined;
  expect(taskLabPolicyRefusal(configured("human_only"), task("implement", ["health"]))).toMatch(/outside_repository is human_only/);
});

it("does not treat an unreadable trusted configuration as a deterministic refusal", () => {
  expect(taskLabPolicyRefusal({ configPath: "Z:/missing/meritrouter-config.yaml" }, task("implement", ["health"]))).toBeNull();
});
