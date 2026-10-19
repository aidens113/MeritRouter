/**
 * Test-only fault injection: simulate process death at a named point of a run, so recovery can
 * be exercised in-process. Set `SWITCHYARD_FAULT_AT=<point>[:<n>][:<name>]`:
 * - `point`: one of `FAULT_POINTS`;
 * - `n` (default 1): crash on the n-th hit of that point (counted per process, reset when the
 *   variable's value changes or a point is passed while it is unset);
 * - `name` (optional): count only hits whose name matches (the tool name for tool points, the
 *   request purpose for model points).
 * A `SimulatedCrash` is thrown; the executor lets it pass its cleanup, so the session stays
 * `running` and the task lease stays held until it expires, as after a real crash.
 */
export const FAULT_ENV = "SWITCHYARD_FAULT_AT";

export const FAULT_POINTS = ["after_tool_intent", "after_tool_run", "after_model_request", "after_model_response"] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export class SimulatedCrash extends Error {
  constructor(readonly point: FaultPoint) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

let seenSpec = "";
let hits = 0;
let crashes = 0;

/** Forget hit counts (tests call it between cases). */
export function resetFaults(): void {
  seenSpec = "";
  hits = 0;
}

/** How many simulated crashes this process has thrown (tests wait on it). */
export function simulatedCrashCount(): number {
  return crashes;
}

/** Crash here when `SWITCHYARD_FAULT_AT` names this point (and hit count and name). A no-op otherwise. */
export function faultPoint(point: FaultPoint, name?: string): void {
  const spec = process.env[FAULT_ENV];
  if (!spec) {
    seenSpec = ""; // unset resets the count, so the same spec set again counts from zero
    return;
  }
  if (spec !== seenSpec) {
    seenSpec = spec;
    hits = 0;
  }
  const [at, n, filter] = spec.split(":");
  if (at !== point) return;
  if (filter && filter !== name) return;
  hits++;
  if (hits === (n ? Number(n) : 1)) {
    crashes++;
    throw new SimulatedCrash(point);
  }
}

/** True for an error thrown by `faultPoint`. */
export function isSimulatedCrash(err: unknown): err is SimulatedCrash {
  return err instanceof SimulatedCrash;
}
