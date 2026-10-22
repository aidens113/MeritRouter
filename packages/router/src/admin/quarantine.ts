import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import { acknowledgeQuarantine } from "../gateway/quarantine.js";

export function acknowledgeModelQuarantine(sy: Switchyard, endpointId: string, input: { actor: string; reason: string }) {
  if (!sy.catalog.get(endpointId)) throw new SwitchyardError("not_found", `Unknown model ${endpointId}`);
  return acknowledgeQuarantine(sy.db, endpointId, input);
}
