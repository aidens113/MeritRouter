import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Artifact text for the task viewer (first 200 KB). */
export async function GET(req: Request) {
  return handle(async (sy) => {
    const ref = new URL(req.url).searchParams.get("ref") ?? "";
    if (!/^(artifact:)?[A-Za-z0-9_-]+$/.test(ref)) throw new HttpError(400, "ref must be an artifact reference");
    const a = insights.artifactText(sy, ref);
    if (!a) throw new HttpError(404, `No artifact ${ref}`);
    return {
      row: { id: a.row.id, kind: a.row.kind, label: a.row.label, mediaType: a.row.media_type, bytes: a.row.bytes, createdAt: a.row.created_at },
      text: a.text,
      truncated: a.truncated,
    };
  });
}
