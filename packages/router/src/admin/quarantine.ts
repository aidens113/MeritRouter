import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { acknowledgeQuarantine } from "../gateway/quarantine.js";

export function acknowledgeModelQuarantine(sy: MeritRouter, endpointId: string, input: { actor: string; reason: string }) {
  if (!sy.catalog.get(endpointId)) throw new MeritRouterError("not_found", `Unknown model ${endpointId}`);
  return acknowledgeQuarantine(sy.db, endpointId, input);
}
