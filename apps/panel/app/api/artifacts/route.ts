import { insights } from "meritrouter";
import { handle, HttpError, projectParam } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Artifact text for the task viewer (first 200 KB). */
export async function GET(req: Request) {
  return handle(async (sy) => {
    const params = new URL(req.url).searchParams;
    const ref = params.get("ref") ?? "";
    if (!/^(artifact:)?[A-Za-z0-9_-]+$/.test(ref)) throw new HttpError(400, "ref must be an artifact reference");
    // With a project (the page's), only that project's store is read; without one, the artifact
    // is looked up across every project's store and an id held by two is refused.
    const project = projectParam(sy, params);
    const a = insights.artifactText(sy, ref, undefined, project);
    if (!a) throw new HttpError(404, `No artifact ${ref}`);
    return {
      row: { id: a.row.id, kind: a.row.kind, label: a.row.label, mediaType: a.row.media_type, bytes: a.row.bytes, createdAt: a.row.created_at },
      text: a.text,
      truncated: a.truncated,
    };
  });
}
