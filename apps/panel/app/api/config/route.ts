import YAML from "yaml";
import { z } from "zod";
import { insights, type Switchyard } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Path = Array<string | number>;
type Patch = { path: Path; value: unknown };

const Body = z.object({
  patch: z
    .array(z.object({ path: z.array(z.union([z.string().min(1), z.number().int()])).min(1).max(8), value: z.unknown() }))
    .min(1)
    .max(200),
});

function getIn(obj: unknown, path: Path): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

function setIn(obj: Record<string | number, unknown>, path: Path, value: unknown): void {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = value;
}

/**
 * A field whose parent section is absent from the YAML (it runs on defaults) cannot be set alone:
 * `tiers: { T1: { max_score: 5 } }` would drop the other required tier fields. In that case write
 * the nearest missing ancestor with its effective values (defaults included) plus the change.
 */
function expand(sy: Switchyard, patch: Patch[]): Patch[] {
  const doc = YAML.parseDocument(insights.readConfigText(sy));
  const expanded = new Map<string, Patch>();
  const out: Patch[] = [];
  for (const p of patch) {
    let missing = -1;
    for (let i = 1; i < p.path.length; i++) {
      if (!doc.hasIn(p.path.slice(0, i))) {
        missing = i;
        break;
      }
    }
    if (missing < 0) {
      out.push(p);
      continue;
    }
    const anc = p.path.slice(0, missing);
    const key = JSON.stringify(anc);
    let entry = expanded.get(key);
    if (!entry) {
      const base = getIn(sy.cfg, anc);
      entry = { path: anc, value: base && typeof base === "object" ? structuredClone(base) : {} };
      expanded.set(key, entry);
      out.push(entry);
    }
    setIn(entry.value as Record<string, unknown>, p.path.slice(missing), p.value);
  }
  return out;
}

/** Apply form edits to the YAML config, preserving comments. Validated before anything is written. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { patch } = await body(req, Body);
    if (patch.some((p) => p.path[0] === "storage")) throw new HttpError(400, "storage.directory cannot change while SwitchYard is running; edit the YAML and restart", ["storage.directory: cannot change while running"]);
    if (patch.some((p) => p.path[0] === "version")) throw new HttpError(400, "version cannot be edited");
    const r = insights.patchConfig(sy, expand(sy, patch));
    if (!r.ok) throw new HttpError(400, "The config was not saved because it would be invalid.", r.errors);
    return { saved: true };
  });
}
