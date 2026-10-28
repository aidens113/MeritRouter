import type { MeritRouter } from "../core/service.js";
import type { RequestCaptureView } from "../gateway/request-capture.js";
import { RequestCaptures } from "../storage/request-captures.js";
import { locateRequest } from "./project-reads.js";

/**
 * Explicit project scope is required; null is the operator's unscoped history. The capture is
 * read from the request's own store: a project's store in a split installation (whose installation
 * store is the coordination store and holds no captures), the gate's own store otherwise.
 */
export function requestCapture(sy: MeritRouter, id: string, scope: { project: string | null }): RequestCaptureView | null {
  const located = locateRequest(sy, id, scope.project ?? "");
  if (!located || located.db === sy.db) return sy.gate.captures.read(id, scope);
  return new RequestCaptures(located.db).read(id, scope);
}
