import { afterEach, expect, it } from "vitest";
import { taskLabPolicyRefusal, taskLabRetryRefusal } from "../src/verification/task-lab-policy.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });
const spec = (labChecks?: string[]) => ({ profile: "implement", constraints: { acceptanceCriteria: ["x"], ...(labChecks ? { labChecks } : {}) } }) as never;
function configured(outside: "disabled" | "human_only" | "supervisor") {
  env?.cleanup();
  env = makeEnv({ config: baseConfig({ security: { outside_repository: outside } }) });
  return env.cfg;
}

it("refuses only tasks that require Lab checks, and defers to the run's live supervisor authority", () => {
  const cfg = configured("supervisor");
  let asked = 0;
  expect(taskLabPolicyRefusal(cfg, spec(), () => { asked++; return false; })).toBeNull();
  expect(asked).toBe(0);
  expect(taskLabPolicyRefusal(cfg, spec(["health"]), () => false)).toMatch(/implement run has no supervisor Lab authority/);
  expect(taskLabPolicyRefusal(cfg, spec(["health"]), () => true)).toBeNull();
});

it("refuses by the trusted outside-repository policy before asking for authority", () => {
  const never = () => { throw new Error("authority must not be consulted"); };
  expect(taskLabPolicyRefusal(configured("disabled"), spec(["health"]), never)).toMatch(/disabled by security\.outside_repository/);
  expect(taskLabPolicyRefusal(configured("human_only"), spec(["health"]), never)).toMatch(/outside_repository is human_only/);
});

it("fails closed for the gate but is not a deterministic retry refusal when trusted state is unreadable", () => {
  const missing = { configPath: "Z:/missing/meritrouter-config.yaml" };
  expect(() => taskLabPolicyRefusal(missing, spec(["health"]), () => true)).toThrow();
  const task = { spec: spec(["health"]), row: { id: "t1", lease_owner: null, run_count: 0, project_id: "demo", lease_incarnation: null } } as never;
  expect(taskLabRetryRefusal({ cfg: missing as never, db: {} as never, now: () => 0 }, task)).toBeNull();
  // Policy refusals need no claim; authority without a readable claim is not treated as refused.
  expect(taskLabRetryRefusal({ cfg: configured("disabled"), db: {} as never, now: () => 0 }, task)).toMatch(/disabled/);
  expect(taskLabRetryRefusal({ cfg: configured("supervisor"), db: {} as never, now: () => 0 }, task)).toBeNull();
});
