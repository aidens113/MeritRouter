import type { MeritRouter } from "../core/service.js";
import type { RequestCaptureView } from "../gateway/request-capture.js";

/** Explicit project scope is required; null is the operator's unscoped history. */
export function requestCapture(sy: MeritRouter, id: string, scope: { project: string | null }): RequestCaptureView | null {
  return sy.gate.captures.read(id, scope);
}
