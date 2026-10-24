import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";
import { findProject } from "@/lib/project";

export const dynamic = "force-dynamic";

const Body = z.object({ project: z.string().trim().min(1).max(100), path: z.string().trim().min(1).max(500), content: z.string().max(2_000_000), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable() });

export async function GET(req: Request) {
  return handle(sy => {
    const parsed = Body.pick({ project: true, path: true }).safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "A valid project and document path are required");
    const { project, path } = parsed.data;
    if (!findProject(sy, project)) throw new HttpError(404, "Unknown project");
    if (!insights.brainDocumentVisible(project, path)) throw new HttpError(403, "Document is outside this project's Brain scope");
    return { document: insights.brainRead(sy, path, project) };
  });
}

/**
 * Save a brain file as the user, through the project's brain (its grants and folders). Working documents and reports are checked against the
 * working-document protocol; rejections come back as a list so the editor can show them inline.
 */
export async function PUT(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    if (!findProject(sy, b.project)) throw new HttpError(404, `Unknown or archived project ${b.project}`);
    if (!b.path.endsWith(".md")) throw new HttpError(400, "Brain documents are markdown files: the path must end in .md", ["path: must end in .md"]);
    if (!insights.brainDocumentVisible(b.project, b.path)) throw new HttpError(403, "Document is outside this project's Brain scope");
    if (b.path.startsWith("global/preferences/") || new RegExp(`^projects/[^/]+/memory/`).test(b.path)) throw new HttpError(409, "Typed memory must be edited in Memory & preferences so scope, source and authorization are retained");
    try {
      return { saved: await insights.brainWrite(sy, b.path, b.content, b.project, { expectedDigest: b.expectedDigest }) };
    } catch (err) {
      if ((err as { code?: string }).code === "brain_conflict") throw new HttpError(409, (err as Error).message);
      const msg = (err as Error).message;
      // BrainError: "working document rejected: a; b; c" or a single reason.
      const m = /^([a-z ]+ rejected): (.*)$/is.exec(msg);
      const errors = m ? m[2]!.split(/;\s+/) : [msg];
      throw new HttpError(400, m ? `Not saved: the ${m[1]!.replace(/ rejected$/, "")} breaks the protocol.` : `Not saved: ${msg}`, errors);
    }
  });
}
