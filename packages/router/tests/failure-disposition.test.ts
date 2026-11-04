import { expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config/load.js";
import { classifyFailure } from "../src/core/disposition.js";
import { AdmissionDenied } from "../src/core/errors.js";

const cfg = { execution: { on_capacity_exhausted: "queue" } } as ResolvedConfig;
const context = (now: number, deadline = 100) => ({ cfg, now: () => now, deadline: () => deadline });

it("classifies an expired approval wait even before the deadline abort timer fires", () => {
  const signal = new AbortController().signal;
  expect(signal.aborted).toBe(false);
  expect(classifyFailure(new Error("worker action wait cancelled or original lease lost"), signal, context(100)))
    .toEqual({ kind: "final", state: "failed", stopReason: "deadline_exceeded" });
});

it("retains a genuine internal failure before the deadline and for an unlimited run", () => {
  for (const f of [context(99), context(1000, Infinity)])
    expect(classifyFailure(new Error("broken invariant"), new AbortController().signal, f))
      .toEqual({ kind: "final", state: "failed", stopReason: "internal_error: broken invariant" });
});

it.each(["cancel_requested", "lease_lost", "task_not_active"] as const)("preserves explicit %s authority after wall time expires", reason => {
  const actual = classifyFailure(new AdmissionDenied(reason, "captured authority ended"), new AbortController().signal, context(101));
  expect(actual).toEqual(reason === "cancel_requested"
    ? { kind: "final", state: "cancelled", stopReason: "cancelled before dispatch" }
    : { kind: "abandon", reason });
});

it.each(["cancel", "lease_lost", "shutdown", "watchdog"] as const)("preserves a controller's %s disposition after the deadline", reason => {
  const controller = new AbortController(); controller.abort(reason);
  expect(classifyFailure(new Error("stopped"), controller.signal, context(101))).toEqual(reason === "cancel"
    ? { kind: "final", state: "cancelled", stopReason: "cancelled while running" }
    : { kind: "abandon", reason: reason === "lease_lost" ? "lease lost" : reason });
});
