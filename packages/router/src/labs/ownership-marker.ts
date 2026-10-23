import { existsSync } from "node:fs";
import path from "node:path";

/** Read compatibility only. New Labs always create the canonical marker. */
export function labOwnershipMarker(root: string): string {
  const canonical = path.join(root, ".meritrouter-lab.json");
  return existsSync(canonical) ? canonical : path.join(root, ".switchyard-lab.json");
}
