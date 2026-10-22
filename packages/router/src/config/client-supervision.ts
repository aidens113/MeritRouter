import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ClientSupervisionSchema } from "./schema.js";

/** Read authored policy by content, including saves sharing the same filesystem timestamp. */
export function readClientSupervision(configPath: string) {
  return z.object({ client_supervision: ClientSupervisionSchema.prefault({}) }).parse(YAML.parse(readFileSync(configPath, "utf8"))).client_supervision;
}
