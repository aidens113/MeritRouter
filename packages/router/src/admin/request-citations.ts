import { z } from "zod";
import type { WebCitation } from "../gateway/types.js";

const CitationsSchema = z.array(z.object({ url: z.string(), title: z.string().nullable(), text: z.string().nullable() }));

/** Stored citations (a JSON column); anything malformed reads as none. */
export function parseCitations(raw: unknown): WebCitation[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const r = CitationsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}
